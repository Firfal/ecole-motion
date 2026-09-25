#!/usr/bin/env node
/**
 * package-instatic.mjs — prépare `site/` pour le « Super Import » d'Instatic
 * (https://github.com/corebunch/instatic, docs/features/site-import.md).
 *
 * Instatic transforme chaque .html en page, chaque CSS en règles éditables, et
 * relie les pages entre elles s'il voit des liens vers les fichiers sources
 * (`formations.html`). Le site hébergé utilise des URLs propres (`/formations`),
 * on les convertit donc ici en liens relatifs vers les fichiers .html.
 *
 *   node scripts/package-instatic.mjs   → dist/instatic-import/ + dist/instatic-import.zip
 */
import * as cheerio from 'cheerio'
import { execFileSync } from 'node:child_process'
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SRC = path.resolve(process.argv[2] || 'site')
const OUT = path.resolve('dist/instatic-import')

async function walk(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

await rm(path.resolve('dist'), { recursive: true, force: true })
await cp(SRC, OUT, { recursive: true })
await rm(path.join(OUT, '_mirror-report.json'), { force: true })
// le script Firestore n'a de sens que sur Firebase Hosting
await rm(path.join(OUT, 'js/forms-firebase.js'), { force: true })

const files = await walk(OUT)
const htmlFiles = new Set(files.filter((f) => f.endsWith('.html')).map((f) => path.relative(OUT, f)))

for (const rel of htmlFiles) {
  const file = path.join(OUT, rel)
  const $ = cheerio.load(await readFile(file, 'utf8'), { decodeEntities: false })
  const dir = path.dirname(rel)
  $('script[src="/js/forms-firebase.js"]').remove()
  $('a[href^="/"]').each((_, el) => {
    const href = $(el).attr('href')
    const m = href.match(/^([^?#]*)([?#].*)?$/)
    const p = m[1].replace(/\/+$/, '')
    const target = p === '' ? 'index.html' : p.slice(1) + '.html'
    if (!htmlFiles.has(target)) return
    let relHref = path.relative(dir, target) || path.basename(target)
    $(el).attr('href', relHref + (m[2] || ''))
  })
  await writeFile(file, $.html())
}

execFileSync('zip', ['-qr', '../instatic-import.zip', '.'], { cwd: OUT })
console.log(`OK: ${htmlFiles.size} pages → dist/instatic-import.zip`)
