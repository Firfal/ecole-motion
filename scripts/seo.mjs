#!/usr/bin/env node
/**
 * seo.mjs — corrections SEO appliquées à `site/` après l'aspiration
 * (`npm run mirror && npm run seo`). Idempotent : peut être relancé sans effet
 * de bord. Tout ce qui est éditorial (titres, descriptions, alt, pages en
 * noindex…) se règle dans `seo.config.json`.
 *
 * - titres / meta descriptions / Open Graph (URLs d'image absolues)
 * - balise canonical sur chaque page (vers www.ecolemotion.com), noindex des pages utilitaires
 * - sitemap.xml régénéré (pages indexables uniquement)
 * - données structurées JSON-LD (Organization, WebSite, Course, FAQPage)
 * - images : WebP pour les fichiers lourds, width/height (anti-CLS), alt, chargement
 *   immédiat des images visibles au premier écran
 * - iframes en chargement différé + title, agenda Cal.com chargé à l'approche
 * - un seul H1 par page (les suivants deviennent des H2 au rendu identique)
 */
import * as cheerio from 'cheerio'
import sharp from 'sharp'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(process.argv[2] || 'site')
const config = JSON.parse(await readFile('seo.config.json', 'utf8'))
const ORIGIN = config.origin.replace(/\/$/, '')
const HEAVY_IMAGE_BYTES = 300 * 1024

async function walk(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const files = await walk(ROOT)
const htmlFiles = files.filter((f) => f.endsWith('.html'))
const cssFiles = files.filter((f) => f.endsWith('.css'))
const pagePath = (file) => {
  const rel = path.relative(ROOT, file).replace(/\.html$/, '')
  return rel === 'index' ? '/' : '/' + rel
}
const absUrl = (p) => ORIGIN + (p === '/' ? '/' : p)

// ------------------------------------------------ 1. images lourdes → WebP

const texts = new Map() // fichier html/css -> contenu (modifié en mémoire)
for (const f of [...htmlFiles, ...cssFiles]) texts.set(f, await readFile(f, 'utf8'))

let converted = 0
let savedBytes = 0
for (const f of files) {
  if (!/\/images\/[^/]+\.(png|jpe?g)$/i.test(f)) continue
  const { size } = await stat(f)
  if (size < HEAVY_IMAGE_BYTES) continue
  const ref = '/' + path.relative(ROOT, f)
  if (![...texts.values()].some((t) => t.includes(ref))) continue // inutilisée
  const webpFile = f.replace(/\.(png|jpe?g)$/i, '.webp')
  if (existsSync(webpFile)) continue
  const buf = await sharp(f).webp({ quality: 82, effort: 5 }).toBuffer()
  if (buf.length > size * 0.7) continue // gain trop faible : on garde l'original
  await writeFile(webpFile, buf)
  const newRef = '/' + path.relative(ROOT, webpFile)
  for (const [k, t] of texts) texts.set(k, t.split(ref).join(newRef))
  await unlink(f)
  converted++
  savedBytes += size - buf.length
}

// ------------------------------------------------------------ 2. pages HTML

const dimsCache = new Map()
async function dims(src) {
  if (dimsCache.has(src)) return dimsCache.get(src)
  let d = null
  const file = path.join(ROOT, decodeURIComponent(src.split(/[?#]/)[0]))
  if (src.startsWith('/') && existsSync(file)) {
    try {
      const m = await sharp(file).metadata()
      if (m.width && m.height) d = { width: m.width, height: m.height }
    } catch {}
  }
  dimsCache.set(src, d)
  return d
}

function faqFrom($) {
  const items = []
  $('.question').each((_, el) => {
    const q = $(el).find('.question_text').map((_, t) => $(t).text().trim()).get().join(' ').replace(/\s+/g, ' ').trim()
    const a = $(el).find('.answer_text').text().replace(/\s+/g, ' ').trim()
    if (q && a) items.push({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })
  })
  return items
}

const SEO_CSS = [
  // les images reçoivent width/height (réserve la place → pas de CLS) sans changer leur rendu :
  // spécificité nulle, toute règle du site reste prioritaire
  ':where(img[width][height]){width:auto;height:auto}',
  // H1 secondaires devenus H2 : mêmes styles de balise que h1 (même spécificité que « h2 »)
  'h2:where(.was-h1){margin-top:0;margin-bottom:0;font-family:Monasans,sans-serif;font-size:38px;font-weight:900;line-height:44px}',
  ...(config.css || []),
].join('\n')

const IFRAME_TITLES = [
  [/miro\.com/, 'Tableau Miro de la formation'],
  [/vimeo|embedly/, 'Vidéo Ecole Motion'],
  [/cal\.com/, 'Réserver un appel de découverte'],
]

const sitemap = []
const stats = { pages: 0, alts: 0, dims: 0, eager: 0, iframes: 0, h1: 0 }

for (const file of htmlFiles) {
  const p = pagePath(file)
  const conf = config.pages[p] || {}
  const $ = cheerio.load(texts.get(file), { decodeEntities: false })
  stats.pages++

  // --- titre et descriptions
  const setMeta = (sel, attr, value) => {
    let el = $(sel)
    if (!el.length) {
      el = $(`<meta ${attr}>`)
      $('head').append(el)
    }
    el.attr('content', value)
  }
  if (conf.title) {
    $('title').text(conf.title)
    setMeta('meta[property="og:title"]', `property="og:title"`, conf.title)
    if ($('meta[name="twitter:title"]').length) setMeta('meta[name="twitter:title"]', '', conf.title)
  }
  if (conf.description) {
    setMeta('meta[name="description"]', `name="description"`, conf.description)
    setMeta('meta[property="og:description"]', `property="og:description"`, conf.description)
    if ($('meta[name="twitter:description"]').length) setMeta('meta[name="twitter:description"]', '', conf.description)
  }
  // og:image / twitter:image : URL absolue obligatoire
  $('meta[property="og:image"],meta[name="twitter:image"]').each((_, el) => {
    const c = $(el).attr('content') || ''
    if (c.startsWith('/')) $(el).attr('content', ORIGIN + c)
  })

  // --- indexation
  $('link[rel="canonical"],meta[name="robots"],meta[property="og:url"]').remove()
  if (conf.noindex) {
    $('head').append('<meta name="robots" content="noindex, follow">')
  } else {
    const canonical = absUrl(conf.canonical || p)
    $('head').append(`<link rel="canonical" href="${canonical}">`)
    $('head').append(`<meta property="og:url" content="${canonical}">`)
    if (!conf.canonical && conf.sitemap !== false) sitemap.push(canonical)
  }

  // --- données structurées
  $('script[type="application/ld+json"][data-seo]').remove()
  const graph = []
  const org = {
    '@type': 'Organization',
    '@id': ORIGIN + '/#organization',
    name: config.organization.name,
    url: ORIGIN + '/',
    logo: ORIGIN + config.organization.logo,
    sameAs: config.organization.sameAs,
  }
  for (const kind of conf.jsonld || []) {
    if (kind === 'organization') graph.push(org)
    if (kind === 'website') graph.push({ '@type': 'WebSite', '@id': ORIGIN + '/#website', name: config.organization.name, url: ORIGIN + '/', inLanguage: 'fr-FR', publisher: { '@id': org['@id'] } })
    if (kind === 'course' && conf.course) graph.push({ '@type': 'Course', name: conf.course.name, description: conf.course.description, url: absUrl(p), inLanguage: 'fr', provider: { '@type': 'Organization', name: org.name, sameAs: org.url } })
    if (kind === 'faq') {
      const faq = faqFrom($)
      if (faq.length) graph.push({ '@type': 'FAQPage', mainEntity: faq })
    }
  }
  if (graph.length) {
    const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c')
    $('head').append(`<script type="application/ld+json" data-seo>${json}</script>`)
  }

  // --- styles de compatibilité
  $('style[data-seo]').remove()
  $('head').append(`<style data-seo>${SEO_CSS}</style>`)

  // --- un seul H1
  if (conf.demoteExtraH1) {
    $('h1').slice(1).each((_, el) => {
      el.tagName = 'h2'
      el.name = 'h2'
      $(el).addClass('was-h1')
      stats.h1++
    })
  }

  // --- liens du logo (href="#" → accueil, avec un nom accessible)
  $('a.w-nav-brand[href="#"], a.footer-brand[href="#"], a.brand[href="#"]').each((_, el) => {
    $(el).attr('href', '/').attr('aria-label', 'Ecole Motion, accueil')
  })

  // --- images
  const eager = [...(config.eagerImages['*'] || []), ...(config.eagerImages[p] || [])]
  for (const el of $('img').toArray()) {
    const $img = $(el)
    const src = $img.attr('src') || ''
    const base = src.split('/').pop()
    if ($img.attr('alt') === '' || $img.attr('alt') === undefined) {
      const key = Object.keys(config.alts).find((k) => base.includes(k.replace(/\.[a-z0-9]+$/i, '')))
      if (key) {
        $img.attr('alt', config.alts[key])
        stats.alts++
      }
    }
    if (!$img.attr('width') || !$img.attr('height')) {
      const d = await dims(src)
      if (d) {
        $img.attr('width', String(d.width)).attr('height', String(d.height))
        stats.dims++
      }
    }
    if (eager.some((e) => base.endsWith(e.replace(/\.[a-z0-9]+$/i, '')) || base.endsWith(e))) {
      if ($img.attr('loading') !== 'eager') stats.eager++
      $img.attr('loading', 'eager')
    }
  }

  // --- iframes
  $('iframe').each((_, el) => {
    const $f = $(el)
    const src = $f.attr('src') || ''
    if (!$f.attr('loading')) $f.attr('loading', 'lazy')
    if (!$f.attr('title')) {
      const t = IFRAME_TITLES.find(([re]) => re.test(src))
      if (t) $f.attr('title', t[1])
    }
    // intégrations très lourdes (Miro ≈ 10 Mo) : src posée seulement à l'approche de l'écran,
    // le lazy-loading natif de Chrome les chargeait plusieurs milliers de pixels à l'avance
    if ((config.deferIframes || []).some((d) => src.includes(d))) {
      $f.attr('data-seo-src', src).removeAttr('src')
    }
    stats.iframes++
  })
  $('script[data-seo-defer]').remove()
  if ($('iframe[data-seo-src]').length) {
    $('body').append(
      `<script data-seo-defer>(function(){var fs=[].slice.call(document.querySelectorAll('iframe[data-seo-src]'));var load=function(f){f.src=f.getAttribute('data-seo-src');f.removeAttribute('data-seo-src')};if(!('IntersectionObserver' in window)){fs.forEach(load);return}var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){io.unobserve(e.target);load(e.target)}})},{rootMargin:'300px'});fs.forEach(function(f){io.observe(f)})})();</script>`,
    )
  }

  // --- agenda Cal.com : chargé seulement quand on s'en approche (~1 Mo de JS en moins au chargement)
  $('script:not([src])').each((_, el) => {
    const code = $(el).html() || ''
    if (!code.includes('app.cal.com/embed/embed.js') || code.includes('/*seo:lazy-cal*/')) return
    $(el).html(`/*seo:lazy-cal*/(function(){var run=function(){${code}\n};var go=function(){var el=document.querySelector('#my-cal-inline');if(!el||!('IntersectionObserver' in window)){run();return}var io=new IntersectionObserver(function(es){if(es.some(function(e){return e.isIntersecting})){io.disconnect();run()}},{rootMargin:'800px'});io.observe(el)};if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',go)}else{go()}})();`)
  })

  // --- page de recherche en français
  if (p === '/search') {
    $('h1').filter((_, e) => $(e).text().trim() === 'Search results').text('Résultats de recherche')
    $('label[for="search"]').text('Rechercher')
    $('input[name="query"]').attr('placeholder', 'Rechercher…')
    $('input[type="submit"][value="Search"]').attr('value', 'Rechercher')
    $('div').filter((_, e) => $(e).children().length === 0 && $(e).text().trim() === 'No matching results.').text('Aucun résultat.')
  }

  texts.set(file, $.html())
}

for (const [f, t] of texts) await writeFile(f, t)

// ------------------------------------------------------------- 3. sitemap

const today = new Date().toISOString().slice(0, 10)
sitemap.sort((a, b) => (a === ORIGIN + '/' ? -1 : b === ORIGIN + '/' ? 1 : a.localeCompare(b)))
await writeFile(
  path.join(ROOT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    sitemap.map((u) => `  <url>\n    <loc>${u}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`).join('\n') +
    '\n</urlset>\n',
)

console.log(
  `OK: ${stats.pages} pages — ${converted} images converties en WebP (−${(savedBytes / 1048576).toFixed(1)} Mo), ` +
    `${stats.alts} alt, ${stats.dims} dimensions, ${stats.eager} images au premier écran, ` +
    `${stats.h1} H1 → H2, ${sitemap.length} URLs dans le sitemap`,
)
