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
import { writeFileSync } from 'node:fs'
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
  $('script[src^="/js/forms-firebase.js"]').remove()
  // empreintes de cache (?v=…) ajoutées par seo.mjs : inutiles pour Instatic
  $('link[href*=".css?v="],script[src*=".js?v="]').each((_, el) => {
    const attr = el.name === 'link' ? 'href' : 'src'
    $(el).attr(attr, $(el).attr(attr).replace(/\?v=[0-9a-f]+$/, ''))
  })
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

// Ajustements CSS pour Instatic (le site Firebase n'est pas touché) :
//  - les noms de variables CSS non ASCII (« --blanc-cassé ») sont refusés → translittérés ;
//  - les polices intégrées en data: URI (webflow-icons : hamburger, flèches…) sont
//    ignorées → extraites en vrais fichiers dans fonts/.
const asciiVar = (name) => name.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]/g, '-')
const nonAsciiVars = new Set()
const textFiles = files.filter((f) => /\.(css|html)$/.test(f))
for (const f of textFiles) {
  for (const m of (await readFile(f, 'utf8')).matchAll(/--[A-Za-z0-9_À-￿-]*[^\x00-\x7F][A-Za-z0-9_À-￿-]*/g)) nonAsciiVars.add(m[0])
}
let fontIndex = 0
for (const f of textFiles) {
  let text = await readFile(f, 'utf8')
  for (const v of nonAsciiVars) text = text.split(v).join(asciiVar(v))
  if (f.endsWith('.css')) {
    text = text.replace(
      /(@font-face\s*{[^}]*?font-family:\s*['"]?([^'";]+)['"]?[^}]*?)url\(\s*['"]?data:(?:application|font)\/(x-font-)?(woff2?|ttf|truetype|opentype|otf)(?:;[^;,]*?)*?;base64,([A-Za-z0-9+/=]+)['"]?\s*\)/g,
      (m, before, family, _x, fmt, b64) => {
        const ext = { truetype: 'ttf', opentype: 'otf' }[fmt] || fmt
        const name = `fonts/${family.trim().replace(/[^A-Za-z0-9_-]+/g, '-')}-${++fontIndex}.${ext}`
        execFileSync('mkdir', ['-p', path.join(OUT, 'fonts')])
        writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64'))
        return `${before}url('/${name}')`
      },
    )
  }
  await writeFile(f, text)
}

execFileSync('zip', ['-qr', '../instatic-import.zip', '.'], { cwd: OUT })
console.log(`OK: ${htmlFiles.size} pages → dist/instatic-import.zip`)
