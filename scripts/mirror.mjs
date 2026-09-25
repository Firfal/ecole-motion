#!/usr/bin/env node
/**
 * mirror.mjs — aspire le site Webflow publié et le transforme en site statique
 * autonome dans `site/` (même arborescence qu'un export Webflow).
 *
 *   node scripts/mirror.mjs [--origin https://www.ecolemotion.com] [--out site]
 *
 * - Parcourt le sitemap + tous les liens internes (BFS).
 * - Télécharge toutes les ressources hébergées par Webflow (CSS, JS, images,
 *   polices, vidéos, Lottie, PDF…) dans css/ js/ images/ fonts/ documents/ videos/.
 * - Réécrit les URLs en chemins absolus locaux (/images/x.webp), ce qui marche
 *   sur Firebase Hosting et que l'import Instatic sait résoudre.
 * - Les liens internes restent des URLs propres (/formations), servies par
 *   Firebase grâce à `cleanUrls`.
 * - Écrit `site/_mirror-report.json` (pages, ressources, erreurs, formulaires).
 */
import { EnvHttpProxyAgent, fetch, setGlobalDispatcher } from 'undici'
import * as cheerio from 'cheerio'
import { createHash } from 'node:crypto'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

setGlobalDispatcher(new EnvHttpProxyAgent())

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]])
    return acc
  }, []),
)
const ORIGIN = (args.origin || 'https://www.ecolemotion.com').replace(/\/$/, '')
const OUT = path.resolve(args.out || 'site')
const SITE_HOSTS = new Set([new URL(ORIGIN).host, new URL(ORIGIN).host.replace(/^www\./, '')])

/** Hôtes dont on rapatrie les fichiers (tout ce qui disparaît avec l'abonnement). */
const ASSET_HOSTS = [
  'cdn.prod.website-files.com',
  'assets-global.website-files.com',
  'assets.website-files.com',
  'uploads-ssl.webflow.com',
  'global-uploads.webflow.com',
  'd3e54v103j8qbb.cloudfront.net',
  'd1otoma47x30pg.cloudfront.net',
  ...(args['asset-host'] ? [args['asset-host']] : []), // pour les tests locaux
]
const ASSET_URL_RE = new RegExp(
  `(?:https?:)?//(?:${ASSET_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})/[^\\s"'()<>\\\\,]+`,
  'g',
)

const pages = new Map() // pathname -> { url, file, status }
const assets = new Map() // absolute url (sans query/hash) -> local path ('images/x.png')
const usedLocal = new Map() // local path -> url
const errors = []
const forms = []
const externalScripts = new Set()
const searchIndex = []

// ---------------------------------------------------------------- utilitaires

async function get(url, { binary = false, tries = 4, acceptStatus = [] } = {}) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'manual',
        headers: { 'user-agent': 'Mozilla/5.0 (migration ecole-motion)', 'accept-encoding': 'gzip, br' },
      })
      if (res.status >= 300 && res.status < 400) {
        return { status: res.status, location: new URL(res.headers.get('location'), url).href }
      }
      if (!res.ok && !acceptStatus.includes(res.status)) return { status: res.status }
      const body = binary ? Buffer.from(await res.arrayBuffer()) : await res.text()
      return { status: res.status, body, type: res.headers.get('content-type') || '' }
    } catch (e) {
      if (i === tries) return { status: 0, error: String(e) }
      await new Promise((r) => setTimeout(r, 500 * 2 ** i))
    }
  }
}

function folderFor(file, type = '') {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.css') return 'css'
  if (ext === '.js' || ext === '.mjs') return 'js'
  if (['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext)) return 'fonts'
  if (['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(ext)) return 'videos'
  if (['.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.json', '.lottie', '.txt', '.csv'].includes(ext)) return 'documents'
  if (type.startsWith('text/css')) return 'css'
  if (type.includes('javascript')) return 'js'
  return 'images'
}

function localNameFor(absUrl) {
  const u = new URL(absUrl)
  let base = decodeURIComponent(u.pathname.split('/').pop() || 'file')
  // jquery-3.x.min.dc5e7f18c8.js?site=… → garde le nom, oublie la query
  base = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.') // « avocat..jpg » : Instatic rejette tout chemin contenant « .. »
    .replace(/^[.-]+/, '')
  if (base.length > 120) {
    const ext = path.extname(base)
    base = base.slice(0, 110 - ext.length) + ext
  }
  let local = `${folderFor(base)}/${base}`
  if (usedLocal.has(local) && usedLocal.get(local) !== absUrl) {
    const h = createHash('sha1').update(absUrl).digest('hex').slice(0, 8)
    const ext = path.extname(base)
    local = `${folderFor(base)}/${base.slice(0, base.length - ext.length)}-${h}${ext}`
  }
  usedLocal.set(local, absUrl)
  return local
}

function normalizeAssetUrl(raw, base) {
  let s = raw.replace(/&amp;/g, '&').trim()
  if (s.startsWith('//')) s = 'https:' + s
  const u = new URL(s, base)
  u.hash = ''
  return u
}

async function writeOut(local, data) {
  const file = path.join(OUT, local)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, data)
}

// -------------------------------------------------------------------- assets

const inflight = new Map()

/** Télécharge une ressource (une seule fois) et renvoie son chemin local absolu `/images/x.png`. */
function asset(rawUrl, base) {
  let u
  try {
    u = normalizeAssetUrl(rawUrl, base)
  } catch {
    return null
  }
  // la query (?site=… pour jQuery) ne change pas le fichier : on l'ignore pour la clé
  const key = u.origin + u.pathname
  if (assets.has(key)) return '/' + assets.get(key)
  const local = localNameFor(key)
  assets.set(key, local)
  inflight.set(key, downloadAsset(u.href, local))
  return '/' + local
}

async function downloadAsset(url, local) {
  const r = await get(url, { binary: true })
  if (r.status === 301 || r.status === 302) {
    const r2 = await get(r.location, { binary: true })
    Object.assign(r, r2)
  }
  if (!r.body) {
    errors.push({ kind: 'asset', url, status: r.status, error: r.error })
    return
  }
  let data = r.body
  const ext = path.extname(local).toLowerCase()
  if (ext === '.css') data = Buffer.from(await rewriteCss(data.toString('utf8'), url))
  else if (ext === '.js' || ext === '.json') data = Buffer.from(rewriteText(data.toString('utf8'), url))
  await writeOut(local, data)
}

async function rewriteCss(css, base) {
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
    if (/^(data:|#|about:)/.test(ref)) return m
    let abs
    try {
      abs = new URL(ref.replace(/&amp;/g, '&'), base)
    } catch {
      return m
    }
    if (!isAssetHost(abs.host) && !SITE_HOSTS.has(abs.host)) return m
    const local = asset(abs.href, base)
    return local ? `url(${q}${local}${q})` : m
  })
  css = css.replace(/@import\s+(?:url\()?\s*(['"])([^'"]+)\1\s*\)?/g, (m, q, ref) => {
    const abs = new URL(ref, base)
    if (!isAssetHost(abs.host)) return m
    return `@import url(${q}${asset(abs.href, base)}${q})`
  })
  return css
}

function isAssetHost(host) {
  return ASSET_HOSTS.includes(host)
}

/** Remplace toutes les URLs d'hôtes Webflow présentes dans un texte (HTML, JSON, JS). */
function rewriteText(text, base) {
  return text.replace(ASSET_URL_RE, (m) => asset(m, base) || m)
}

// --------------------------------------------------------------------- pages

function pageFile(pathname) {
  let p = decodeURIComponent(pathname).replace(/\/+$/, '')
  if (p === '') return 'index.html'
  return p.replace(/^\//, '') + '.html'
}

function internalPath(href, base) {
  if (!href) return null
  if (/^(mailto:|tel:|javascript:|#|data:|sms:)/i.test(href.trim())) return null
  let u
  try {
    u = new URL(href.trim(), base)
  } catch {
    return null
  }
  if (!/^https?:$/.test(u.protocol) || !SITE_HOSTS.has(u.host)) return null
  return u
}

const queue = []
function enqueue(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/'
  if (pages.has(p)) return
  // on ne crawle pas les fichiers (pdf…) servis par le domaine
  if (/\.[a-z0-9]{2,5}$/i.test(p) && !/\.html?$/i.test(p)) return
  pages.set(p, { url: ORIGIN + p, file: pageFile(p) })
  queue.push(p)
}

async function crawlPage(p) {
  const entry = pages.get(p)
  const r = await get(entry.url, { acceptStatus: p === '/404' ? [404] : [] })
  entry.status = r.status
  if (r.location) {
    const target = internalPath(r.location, entry.url)
    entry.redirect = target ? target.pathname : r.location
    if (target) enqueue(target.pathname)
    return
  }
  if (!r.body) {
    errors.push({ kind: 'page', url: entry.url, status: r.status, error: r.error })
    return
  }
  const $ = cheerio.load(r.body, { decodeEntities: false })

  // liens internes -> URLs propres, et découverte
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    const u = internalPath(href, entry.url)
    if (!u) return
    enqueue(u.pathname)
    const clean = (u.pathname.replace(/\/+$/, '') || '/') + u.search + u.hash
    $(el).attr('href', clean)
  })
  $('link[rel=canonical]').each((_, el) => {
    const u = internalPath($(el).attr('href'), entry.url)
    if (u) $(el).attr('href', ORIGIN + (u.pathname.replace(/\/+$/, '') || '/'))
  })

  // inventaire des formulaires (Webflow Forms cessera de fonctionner)
  $('form').each((_, el) => {
    forms.push({
      page: p,
      id: $(el).attr('id'),
      name: $(el).attr('name') || $(el).attr('data-name'),
      action: $(el).attr('action') || null,
      method: $(el).attr('method') || null,
      fields: $(el)
        .find('input,select,textarea')
        .map((_, f) => $(f).attr('name') || $(f).attr('type'))
        .get(),
    })
  })
  $('script[src]').each((_, el) => {
    const s = $(el).attr('src')
    try {
      const h = new URL(s, entry.url).host
      if (!isAssetHost(h) && !SITE_HOSTS.has(h)) externalScripts.add(s)
    } catch {}
  })

  // <style> et style="" : url() -> local
  for (const el of $('style').toArray()) {
    $(el).text(await rewriteCss($(el).text(), entry.url))
  }
  for (const el of $('[style]').toArray()) {
    $(el).attr('style', await rewriteCss($(el).attr('style'), entry.url))
  }

  // --- nettoyage de ce qui dépend de l'hébergement Webflow ---
  // Les empreintes SRI (integrity=) ne correspondent plus : les CSS/JS rapatriés
  // ont leurs URLs réécrites. On les retire pour les fichiers devenus locaux.
  $('link[integrity],script[integrity]').each((_, el) => {
    const ref = $(el).attr('href') || $(el).attr('src')
    try {
      if (isAssetHost(new URL(ref, entry.url).host)) $(el).removeAttr('integrity').removeAttr('crossorigin')
    } catch {}
  })
  // preconnect/dns-prefetch vers le CDN Webflow : inutiles une fois les fichiers locaux
  $('link[rel=preconnect],link[rel=dns-prefetch]').each((_, el) => {
    try {
      if (isAssetHost(new URL($(el).attr('href'), entry.url).host)) $(el).remove()
    } catch {}
  })
  // Google tag servi en « first-party » par l'hébergement Webflow (/xxxx/yyyy) :
  // on revient au chargement standard de gtag.js, qui fonctionne partout.
  $('script').each((_, el) => {
    const code = $(el).html() || ''
    const m = code.match(/\['(G-[A-Z0-9]+)'\],'google_tags_first_party'/)
    if (!m) return
    const next = $(el).next('script[src]')
    if (next.length && /^\/[A-Za-z0-9]{20,}\/[A-Za-z0-9_-]+$/.test(next.attr('src'))) {
      next.attr('src', `https://www.googletagmanager.com/gtag/js?id=${m[1]}`)
    }
    $(el).remove()
  })
  // recherche de site Webflow (côté serveur) → recherche locale
  if (p === '/search') {
    $('body').append('<script src="/js/site-search.js" defer></script>\n')
  }

  // remplace le traitement Webflow Forms par Firestore
  if ($('.w-form form').length && !$('script[src="/js/forms-firebase.js"]').length) {
    $('body').append('<script src="/js/forms-firebase.js" defer></script>\n')
  }

  // index de recherche (remplace la recherche Webflow)
  if (!['/404', '/search'].includes(p) && !$('meta[name=robots][content*=noindex]').length) {
    const $t = cheerio.load($('body').html() || '')
    $t('script,style,noscript,nav,footer,form,.w-nav,.w-form').remove()
    searchIndex.push({
      path: p,
      title: $('title').text().trim(),
      description: $('meta[name=description]').attr('content') || '',
      text: $t.text().replace(/\s+/g, ' ').trim().slice(0, 20000),
    })
  }

  let html = $.html()
  // toutes les URLs d'hôtes Webflow restantes (src, srcset, data-*, JSON lightbox, meta…)
  html = rewriteText(html, entry.url)
  // og:image / twitter:image doivent rester absolues (Webflow écrit content= AVANT property=)
  html = html.replace(/<meta\b[^>]*"(?:og:image|twitter:image)"[^>]*>/g, (tag) =>
    tag.replace(/content="(\/[^"]*)"/, (_, p2) => `content="${ORIGIN}${p2}"`),
  )
  await writeOut(entry.file, html)
}

/**
 * Webflow ne publie pas de 404 personnalisée pour ce site : il sert sa page
 * d'erreur générique (en anglais, hébergée chez Webflow). On en construit une
 * aux couleurs du site à partir d'une page simple (en-tête + pied de page).
 */
async function build404() {
  const { readFile } = await import('node:fs/promises')
  const file404 = path.join(OUT, '404.html')
  let current = ''
  try {
    current = await readFile(file404, 'utf8')
  } catch {}
  if (current && !/webflow-https-errors/.test(current)) return // vraie 404 du site : on la garde
  const shellPage = [...pages.values()].find((e) => e.file === 'cgv.html' && e.status === 200) ||
    [...pages.values()].find((e) => e.file === 'index.html')
  const $ = cheerio.load(await readFile(path.join(OUT, shellPage.file), 'utf8'), { decodeEntities: false })
  $('title').text('Page introuvable | Ecole Motion')
  $('meta[name=description]').attr('content', "Cette page n'existe pas ou a été déplacée.")
  $('meta[property^="og:"],meta[name^="twitter:"],link[rel=canonical]').remove()
  $('head').append('<meta name="robots" content="noindex">')
  const main = $('body > .w-container').first()
  main.html(
    '<div style="text-align:center;padding:120px 0 140px">' +
      '<h1>404</h1>' +
      "<h2>Page introuvable</h2>" +
      "<p>La page que vous cherchez n'existe pas ou a été déplacée.</p>" +
      '<a href="/" class="button w-button" style="display:inline-block;width:auto;padding-left:48px;padding-right:48px">Retour à l\'accueil</a>' +
      '</div>',
  )
  await writeOut('404.html', $.html())
}

// ---------------------------------------------------------------------- main

async function main() {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  enqueue('/')
  const sm = await get(ORIGIN + '/sitemap.xml')
  if (sm.body) {
    for (const m of sm.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const u = internalPath(m[1], ORIGIN)
      if (u) enqueue(u.pathname)
    }
    await writeOut('sitemap.xml', sm.body)
  }
  const robots = await get(ORIGIN + '/robots.txt')
  if (robots.body) await writeOut('robots.txt', robots.body)

  // 404 Webflow (servie avec un statut 404, on la récupère quand même)
  const nf = await fetch(ORIGIN + '/__page-inexistante__', { redirect: 'manual' }).catch(() => null)
  if (nf && nf.status === 404) {
    pages.set('/404', { url: ORIGIN + '/__page-inexistante__', file: '404.html' })
    queue.push('/404')
  }

  const CONCURRENCY = 6
  while (queue.length) {
    const batch = queue.splice(0, CONCURRENCY)
    await Promise.all(
      batch.map((p) =>
        crawlPage(p).catch((e) => errors.push({ kind: 'page', url: p, error: String(e) })),
      ),
    )
    process.stdout.write(`\rpages: ${pages.size}  assets: ${assets.size}   `)
  }
  // les CSS/JS téléchargés peuvent en découvrir d'autres
  while (inflight.size) {
    const all = [...inflight.values()]
    inflight.clear()
    await Promise.all(all)
  }
  process.stdout.write('\n')

  await build404()

  searchIndex.sort((a, b) => a.path.localeCompare(b.path))
  await writeOut('search-index.json', JSON.stringify(searchIndex))

  // fichiers propres au projet (static/) copiés par-dessus le miroir
  await cp(path.resolve('static'), OUT, { recursive: true })

  const report = {
    origin: ORIGIN,
    date: new Date().toISOString(),
    pages: [...pages.entries()].map(([p, e]) => ({ path: p, ...e })),
    assets: [...assets.entries()].map(([url, local]) => ({ url, local })),
    forms,
    externalScripts: [...externalScripts],
    errors,
  }
  await writeFile(path.join(OUT, '_mirror-report.json'), JSON.stringify(report, null, 2))
  console.log(
    `OK: ${report.pages.filter((p) => p.status === 200).length} pages, ${assets.size} ressources, ` +
      `${forms.length} formulaires, ${errors.length} erreurs`,
  )
  if (errors.length) console.log(errors.slice(0, 20))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
