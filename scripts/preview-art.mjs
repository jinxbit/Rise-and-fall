import { writeFileSync, mkdirSync } from 'node:fs'
import { unitArtFor } from './unit-art.mjs'

const THEMES = {
  city: ['#fbe9c9', '#f0b86e'],
  temple: ['#efe4ff', '#c9a6ff'],
  nomad: ['#f6e2b8', '#e3b673'],
  merchant: ['#d8f5ec', '#9fe0cc'],
  mountaineer: ['#eaf1f7', '#b9cbdc'],
  ship: ['#d7ecff', '#8ecbf5'],
}

const outDir = process.argv[2]
mkdirSync(outDir, { recursive: true })

for (const id of Object.keys(THEMES)) {
  const [c1, c2] = THEMES[id]
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="320" height="320" fill="url(#bg)"/>
    ${unitArtFor(id)}
  </svg>`
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;width:320px;height:320px;overflow:hidden}</style></head><body>${svg}</body></html>`
  writeFileSync(`${outDir}/${id}.html`, html)
}
console.log('wrote previews to', outDir)
