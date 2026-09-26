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

// ------------------------------------------- 1 bis. couleurs (contraste WCAG)

// seo.config.json → cssReplace : [[motif regex, remplacement]] appliqués au CSS du site
// (ex. fonds violets derrière du texte blanc, trop peu contrastés)
for (const [pattern, replacement] of config.cssReplace || []) {
  const re = new RegExp(pattern, 'gi')
  for (const f of cssFiles) texts.set(f, texts.get(f).replace(re, replacement))
}

// ---------------------------------------- 1 ter. polices TTF/OTF → WOFF2

// Les polices uploadées dans Webflow sont en TTF/OTF (≈ 77 Ko chacune) : WOFF2 les divise
// par 2 à 3. Même dessin de caractères, seule la compression change.
{
  const { default: wawoff2 } = await import('wawoff2')
  for (const f of files) {
    if (!/\/fonts\/[^/]+\.(ttf|otf)$/i.test(f)) continue
    const ref = '/' + path.relative(ROOT, f)
    if (![...texts.values()].some((t) => t.includes(ref))) continue
    const woffFile = f.replace(/\.(ttf|otf)$/i, '.woff2')
    const woffRef = '/' + path.relative(ROOT, woffFile)
    if (!existsSync(woffFile)) await writeFile(woffFile, Buffer.from(await wawoff2.compress(await readFile(f))))
    for (const [k, t] of texts) {
      // url("/fonts/x.ttf") format("truetype") → url("/fonts/x.woff2") format("woff2")
      texts.set(k, t.split(ref).join(woffRef).replace(new RegExp(`(${woffRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\)\\s*format\\()(["'])(?:truetype|opentype)\\2`, 'g'), '$1$2woff2$2'))
    }
    await unlink(f)
  }
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

/** Miniature d'une vidéo Vimeo (oEmbed), enregistrée une fois dans /images/vimeo-<id>.webp */
async function vimeoThumb(id, hash) {
  const rel = `/images/vimeo-${id}.webp`
  const file = path.join(ROOT, rel)
  if (existsSync(file)) return rel
  try {
    const url = `https://vimeo.com/${id}${hash ? '/' + hash : ''}`
    const meta = await (await fetch(`https://vimeo.com/api/oembed.json?width=1280&url=${encodeURIComponent(url)}`)).json()
    const img = Buffer.from(await (await fetch(meta.thumbnail_url)).arrayBuffer())
    await writeFile(file, await sharp(img).resize({ width: 1280 }).webp({ quality: 80 }).toBuffer())
    return rel
  } catch (e) {
    console.warn(`miniature Vimeo ${id} indisponible : ${e.message}`)
    return null
  }
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
  // H3 devenus H2 (ordre des titres) : mêmes styles de balise que h3
  'h2:where(.was-h3){margin-top:20px;margin-bottom:10px;font-family:Cabinetgrotesk,sans-serif;font-size:24px;font-weight:900;line-height:30px}',
  // zone <main> ajoutée pour l'accessibilité, sans effet sur la mise en page
  'main[data-seo]{display:contents}',
  // miniature Vimeo cliquable (même emplacement que le lecteur)
  '.seo-vimeo{display:block;padding:0;border:0;margin:0;cursor:pointer;background:#000;overflow:hidden}',
  '.seo-vimeo img{width:100%;height:100%;object-fit:cover;display:block}',
  ".seo-vimeo-play{position:absolute;left:50%;top:50%;width:74px;height:46px;margin:-23px 0 0 -37px;border-radius:8px;background:rgba(23,35,34,.75);transition:background .2s}",
  ".seo-vimeo-play::after{content:'';position:absolute;left:30px;top:13px;border-style:solid;border-width:10px 0 10px 17px;border-color:transparent transparent transparent #fff}",
  '.seo-vimeo:hover .seo-vimeo-play,.seo-vimeo:focus-visible .seo-vimeo-play{background:#00adef}',
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

  // --- tailles réduites (srcset) pour les images servies en pleine taille alors qu'une image
  // voisine de même classe en a déjà : on reprend son attribut sizes
  for (const el of $('img:not([srcset])').toArray()) {
    const $img = $(el)
    const src = $img.attr('src') || ''
    const cls = ($img.attr('class') || '').split(/\s+/).filter((c) => c && !c.startsWith('w-'))[0]
    // uniquement les classes listées (seo.config.json → responsiveImages) : ailleurs, un srcset
    // changerait la taille intrinsèque d'images dont la largeur CSS n'est pas fixée
    if (!cls || !(config.responsiveImages || []).includes(cls)) continue
    if (!/^\/images\/[^/]+\.(avif|webp|jpe?g|png)$/i.test(src)) continue
    const sizes = $(`img.${cls}[srcset][sizes]`).first().attr('sizes')
    const d = await dims(src)
    if (!sizes || !d || d.width <= 900) continue
    const file = path.join(ROOT, src)
    const ext = path.extname(src)
    const set = []
    for (const w of [500, 800, 1080].filter((w) => w < d.width)) {
      const vSrc = src.replace(ext, `-p-${w}${ext}`)
      const vFile = path.join(ROOT, vSrc)
      if (!existsSync(vFile)) {
        const img = sharp(file).resize({ width: w })
        const fmt = ext.slice(1).toLowerCase().replace('jpg', 'jpeg')
        await writeFile(vFile, await img.toFormat(fmt, { quality: 72 }).toBuffer())
      }
      set.push(`${vSrc} ${w}w`)
    }
    set.push(`${src} ${d.width}w`)
    $img.attr('srcset', set.join(', ')).attr('sizes', sizes)
  }

  // --- priorité de chargement de l'élément principal (LCP) de la page
  $('link[data-seo-preload]').remove()
  for (const name of config.lcpImages?.[p] || []) {
    const img = $('img').filter((_, e) => ($(e).attr('src') || '').includes(name)).first()
    if (img.length) img.attr('fetchpriority', 'high').attr('loading', 'eager')
  }
  for (const name of config.preloadImages?.[p] || []) {
    const f = files.find((x) => x.includes('/images/') && x.endsWith(name))
    if (f) $('head').append(`<link rel="preload" as="image" href="/${path.relative(ROOT, f)}" fetchpriority="high" data-seo-preload>`)
  }
  for (const name of config.preloadFonts || []) {
    const f = files.map((x) => x.replace(/\.(ttf|otf)$/i, '.woff2')).find((x) => x.includes('/fonts/') && x.includes(name))
    if (f) $('head').append(`<link rel="preload" as="font" type="font/woff2" href="/${path.relative(ROOT, f)}" crossorigin data-seo-preload>`)
  }

  // --- lecteur Vimeo remplacé par sa miniature, chargé au clic : ni cookies tiers ni ~500 Ko
  // de JS tant que la vidéo n'est pas lancée
  for (const el of $('iframe').toArray()) {
    const $f = $(el)
    const src = $f.attr('src') || $f.attr('data-seo-src') || ''
    const m = src.match(/player\.vimeo\.com\/video\/(\d+)(?:\?h=([0-9a-f]+))?/)
    if (!m || !config.vimeoFacade) continue
    const thumb = await vimeoThumb(m[1], m[2])
    if (!thumb) continue
    const base = /[?&]dnt=1/.test(src) ? src : src + (src.includes('?') ? '&' : '?') + 'dnt=1'
    const play = base + '&autoplay=1'
    const title = ($f.attr('title') || 'Vidéo').replace(/"/g, '&quot;')
    $f.replaceWith(
      `<button type="button" class="seo-vimeo" data-src="${play.replace(/&/g, '&amp;')}" aria-label="Lire la vidéo : ${title}" style="${$f.attr('style') || ''}">` +
        `<img src="${thumb}" alt="" width="1280" height="720">` +
        `<span class="seo-vimeo-play" aria-hidden="true"></span></button>`,
    )
  }
  // les vidéos sont en haut de page (souvent l'élément LCP) : miniature prioritaire, 640 px sur mobile
  for (const [i, el] of $('.seo-vimeo img').toArray().entries()) {
    const $img = $(el)
    const src = $img.attr('src')
    const small = src.replace(/\.webp$/, '-640.webp')
    if (!existsSync(path.join(ROOT, small))) {
      await writeFile(path.join(ROOT, small), await sharp(path.join(ROOT, src)).resize({ width: 640 }).webp({ quality: 80 }).toBuffer())
    }
    $img.attr('srcset', `${small} 640w, ${src} 1280w`).attr('sizes', '(max-width: 991px) 100vw, 940px')
    $img.attr('loading', 'eager').attr('decoding', 'async').removeAttr('fetchpriority')
    if (i === 0) $img.attr('fetchpriority', 'high')
  }
  $('script[data-seo-vimeo]').remove()
  if ($('.seo-vimeo').length) {
    $('body').append(
      `<script data-seo-vimeo>document.addEventListener('click',function(e){var b=e.target.closest('.seo-vimeo');if(!b)return;var f=document.createElement('iframe');f.src=b.getAttribute('data-src');f.setAttribute('allow','autoplay; fullscreen; picture-in-picture');f.setAttribute('allowfullscreen','');f.title=b.getAttribute('aria-label');f.style.cssText=b.style.cssText;f.style.border='0';b.replaceWith(f)});</script>`,
    )
  }

  // --- scripts de fin de page (jQuery, Webflow…) : `defer` garde l'ordre d'exécution et les lance
  // avant DOMContentLoaded, comme aujourd'hui, mais sans retarder le premier rendu
  if (config.deferBodyScripts) $('body script[src]:not([async])').attr('defer', '')

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

  // --- performances / bonnes pratiques
  // API JavaScript Vimeo : chargée deux fois, jamais utilisée (aucun « new Vimeo.Player »)
  if (!/Vimeo\.Player/.test($.html())) $('script[src*="player.vimeo.com/api/player.js"]').remove()
  // lecteurs Vimeo sans cookies de suivi (dnt=1) : plus de cookies tiers
  $('iframe').each((_, el) => {
    for (const attr of ['src', 'data-seo-src']) {
      const v = $(el).attr(attr)
      if (v && /player\.vimeo\.com\/video\//.test(v) && !/[?&]dnt=1/.test(v)) {
        $(el).attr(attr, v + (v.includes('?') ? '&' : '?') + 'dnt=1')
      } else if (v && /embedly\.com\/widgets\/media\.html/.test(v)) {
        // lecteur Vimeo encapsulé par Embedly : dnt=1 dans l'URL du lecteur passée en paramètre
        const u = new URL(v, 'https://x')
        const inner = u.searchParams.get('src')
        if (inner && /player\.vimeo\.com\/video\//.test(inner) && !/[?&]dnt=1/.test(inner)) {
          u.searchParams.set('src', inner + (inner.includes('?') ? '&' : '?') + 'dnt=1')
          $(el).attr(attr, (v.startsWith('//') ? '//' + u.host : u.origin) + u.pathname + u.search)
        }
      }
    }
  })
  // webfont.js (bloquant) → feuille Google Fonts directe, display=swap, non bloquante
  const wfLoader = $('script[src*="ajax.googleapis.com/ajax/libs/webfont/"]')
  const wfCall = $('script:not([src])').filter((_, el) => /WebFont\.load\(/.test($(el).html() || '')).first()
  if (wfLoader.length && wfCall.length) {
    const m = (wfCall.html() || '').match(/families:\s*(\[[\s\S]*?\])/)
    if (m) {
      const families = JSON.parse(m[1])
      const href = 'https://fonts.googleapis.com/css?family=' + families.map((f) => f.replace(/ /g, '+')).join('|') + '&display=swap'
      wfLoader.replaceWith(
        '<link rel="preconnect" href="https://fonts.googleapis.com">' +
          '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
          `<link rel="stylesheet" href="${href}" media="print" onload="this.media='all'">` +
          `<noscript><link rel="stylesheet" href="${href}"></noscript>`,
      )
      wfCall.remove()
    }
  }
  // scripts tiers retirés (config « removeScripts » : fragments d'URL ou de code)
  for (const needle of config.removeScripts || []) {
    $('script').filter((_, el) => ($(el).attr('src') || '').includes(needle) || ($(el).html() || '').includes(needle)).remove()
  }
  $('*').contents().filter((_, n) => n.type === 'comment' && (config.removeScripts || []).length && /Hotjar/i.test(n.data)).remove()
  // Hotjar chargé après la page (le script d'origine pèse sur le temps de blocage)
  $('script:not([src])').each((_, el) => {
    const code = $(el).html() || ''
    if (!code.includes('static.hotjar.com') || code.includes('/*seo:lazy-hotjar*/')) return
    $(el).html(`/*seo:lazy-hotjar*/window.addEventListener('load',function(){setTimeout(function(){${code}\n},2000)});`)
  })

  // --- accessibilité (sans changement visuel)
  // liens réseaux sociaux composés d'une seule image
  $('a[href]').each((_, el) => {
    const $a = $(el)
    if ($a.attr('aria-label') || $a.text().trim() || $a.find('img[alt]:not([alt=""])').length) return
    const host = ($a.attr('href').match(/^https?:\/\/(?:www\.)?([^/]+)/) || [])[1] || ''
    const name = { 'youtube.com': 'YouTube', 'instagram.com': 'Instagram', 'linkedin.com': 'LinkedIn', 'tiktok.com': 'TikTok', 'x.com': 'X', 'twitter.com': 'X', 'facebook.com': 'Facebook' }[host]
    if (name) $a.attr('aria-label', `Ecole Motion sur ${name}`)
  })
  // titres qui sautent un niveau (h1 → h3) : rendus en h2 avec les styles de h3
  for (const sel of config.promoteToH2 || []) {
    $(sel).each((_, el) => {
      if (el.name !== 'h3') return
      el.name = 'h2'
      el.tagName = 'h2'
      $(el).addClass('was-h3')
    })
  }
  // zone principale <main> (display:contents : aucune incidence sur la mise en page)
  if (!$('main').length) {
    const kids = $('body').children().filter((_, el) => !['script', 'style', 'noscript', 'link'].includes(el.name))
    if (kids.length) {
      kids.first().before('<main data-seo></main>')
      $('main[data-seo]').append(kids)
    }
  }

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

// --- empreinte de contenu sur le CSS et le JS locaux (?v=…) : ils sont mis en cache longtemps
// (firebase.json), le paramètre change dès que leur contenu change → jamais de fichier périmé
const { createHash } = await import('node:crypto')
const versionOf = new Map()
for (const f of files.filter((x) => /\.(css|js)$/.test(x))) {
  const body = texts.has(f) ? texts.get(f) : await readFile(f)
  versionOf.set('/' + path.relative(ROOT, f), createHash('sha256').update(body).digest('hex').slice(0, 10))
}
for (const f of htmlFiles) {
  texts.set(
    f,
    texts.get(f).replace(/(<(?:link|script)\b[^>]*?\s(?:href|src)=")(\/[^"?#]+\.(?:css|js))(?:\?v=[0-9a-f]+)?"/g, (m, a, url) =>
      versionOf.has(url) ? `${a}${url}?v=${versionOf.get(url)}"` : m,
    ),
  )
}

for (const [f, t] of texts) await writeFile(f, t)

// ---------------------------------------------------- 2 bis. CSS critique
// Le CSS Webflow (≈ 115 Ko) bloquait le premier affichage : les règles utiles à la page sont
// intégrées dans un <style>, la feuille complète est chargée sans bloquer (media=print → all).
// Le rendu final est identique : la feuille complète finit toujours par s'appliquer.
{
  const { default: Beasties } = await import('beasties')
  const beasties = new Beasties({
    path: ROOT,
    publicPath: '/',
    preload: 'media',
    noscriptFallback: true,
    pruneSource: false,
    mergeStylesheets: false,
    reduceInlineStyles: false, // ne pas élaguer les <style> existants (ex. :where(img[width][height]))
    inlineFonts: false,
    preloadFonts: false,
    fonts: false,
    compress: false,
    keyframes: 'critical',
    // états posés par le JavaScript Webflow (menus, interactions) : toujours inclus
    allowRules: [/w-mod-/, /w--/, /\.w-nav/, /\.w-dropdown/, /seo-vimeo/],
    logLevel: 'error',
  })
  for (const f of htmlFiles) {
    // retour à l'état d'avant un éventuel passage précédent
    const $0 = cheerio.load(await readFile(f, 'utf8'), { decodeEntities: false })
    $0('style[data-seo-critical], noscript[data-seo-critical]').remove()
    $0('link[data-seo-critical-link]').each((_, el) => {
      $0(el).removeAttr('media').removeAttr('onload').removeAttr('data-seo-critical-link').attr('rel', 'stylesheet')
    })
    const before = new Set($0('style').map((_, e) => $0(e).html()).get())
    const out = await beasties.process($0.html())
    const $ = cheerio.load(out, { decodeEntities: false })
    $('style').each((_, e) => {
      if (!before.has($(e).html())) $(e).attr('data-seo-critical', '')
    })
    $('link[rel="stylesheet"][href^="/css/"][media="print"]').attr('data-seo-critical-link', '')
    $('noscript').each((_, e) => {
      if (/href="\/css\//.test($(e).html() || '')) $(e).attr('data-seo-critical', '')
    })
    await writeFile(f, $.html())
  }
}

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
