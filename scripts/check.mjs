#!/usr/bin/env node
/**
 * check.mjs — vérifie que `site/` est autonome :
 *  - toutes les ressources locales référencées (src, href, srcset, url(), data-*) existent ;
 *  - tous les liens internes pointent vers une page existante (ou une redirection de firebase.json) ;
 *  - plus aucune URL vers les hôtes Webflow.
 * Code de sortie 1 en cas de problème (utilisé par la CI avant déploiement).
 */
import * as cheerio from 'cheerio'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(process.argv[2] || 'site')
const WEBFLOW_RE = /(website-files\.com|uploads-ssl\.webflow\.com|d3e54v103j8qbb\.cloudfront\.net|webflow\.com\/api)/
const redirects = new Set(
  (JSON.parse(await readFile('firebase.json', 'utf8')).hosting.redirects || []).map((r) => r.source),
)

async function walk(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const problems = []
const files = await walk(ROOT)

function localExists(ref) {
  const p = decodeURIComponent(ref.split(/[?#]/)[0])
  return existsSync(path.join(ROOT, p))
}
function pageExists(ref) {
  const p = decodeURIComponent(ref.split(/[?#]/)[0]).replace(/\/+$/, '')
  if (p === '') return true
  if (redirects.has(p)) return true
  return existsSync(path.join(ROOT, p + '.html')) || existsSync(path.join(ROOT, p)) || existsSync(path.join(ROOT, p, 'index.html'))
}

for (const f of files) {
  const rel = path.relative(ROOT, f)
  if (rel === '_mirror-report.json') continue
  if (f.endsWith('.css')) {
    const css = await readFile(f, 'utf8')
    for (const m of css.matchAll(/url\(\s*['"]?(\/[^'")]+)/g)) if (!localExists(m[1])) problems.push(`${rel}: ressource manquante ${m[1]}`)
    if (WEBFLOW_RE.test(css)) problems.push(`${rel}: référence Webflow restante`)
  }
  if (!f.endsWith('.html')) continue
  const html = await readFile(f, 'utf8')
  const $ = cheerio.load(html)
  $('[src],[href],[srcset],[poster],[data-src],[data-poster-url],[data-video-urls]').each((_, el) => {
    const a = el.attribs
    const refs = []
    for (const k of ['src', 'poster', 'data-src', 'data-poster-url']) if (a[k]) refs.push(a[k])
    if (a.srcset) refs.push(...a.srcset.split(',').map((s) => s.trim().split(/\s+/)[0]))
    if (a['data-video-urls']) refs.push(...a['data-video-urls'].split(','))
    if (a.href && el.name !== 'a') refs.push(a.href)
    for (const r of refs) if (r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/__/') && !localExists(r)) problems.push(`${rel}: ressource manquante ${r}`)
    if (el.name === 'a' && a.href && a.href.startsWith('/') && !a.href.startsWith('//')) {
      const isFile = /\.[a-z0-9]{2,5}$/i.test(a.href.split(/[?#]/)[0])
      if (isFile ? !localExists(a.href) : !pageExists(a.href)) problems.push(`${rel}: lien cassé ${a.href}`)
    }
  })
  if (WEBFLOW_RE.test(html.replace(/<!--[\s\S]*?-->/g, ''))) {
    const m = html.match(new RegExp(`.{0,60}${WEBFLOW_RE.source}.{0,60}`))
    problems.push(`${rel}: référence Webflow restante … ${m && m[0]}`)
  }
}

const uniq = [...new Set(problems)]
if (uniq.length) {
  console.log(uniq.slice(0, 200).join('\n'))
  console.log(`\n${uniq.length} problème(s)`)
  process.exit(1)
}
console.log(`OK: ${files.filter((f) => f.endsWith('.html')).length} pages vérifiées, aucune référence cassée ni Webflow.`)
