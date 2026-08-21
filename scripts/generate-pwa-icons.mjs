// Regenerates the PWA icon set (public/icons/) from public/favicon.svg.
// Run with `node scripts/generate-pwa-icons.mjs` after the favicon artwork
// changes. Requires `sharp`, which isn't a regular dependency (it's a heavy
// native module only needed for this one-off), so install it first:
//   npm install --no-save sharp
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '../..')
const svg = readFileSync(resolve(root, 'public/favicon.svg'))
const BG = '#0a0a0a' // neutral-950, matches the app's dark theme (src/index.css)

async function main() {
  // Transparent "any" purpose icons — most launchers add their own backing shape.
  for (const size of [192, 512]) {
    await sharp(svg, { density: 384 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(resolve(root, `public/icons/icon-${size}.png`))
  }

  // Maskable icon — logo padded well inside the safe-zone circle, on a solid background.
  const maskableSize = 512
  const logoSize = Math.round(maskableSize * 0.6)
  const logo = await sharp(svg, { density: 384 })
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  await sharp({ create: { width: maskableSize, height: maskableSize, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(resolve(root, 'public/icons/maskable-icon-512.png'))

  // Apple touch icon — iOS ignores alpha and renders it as black, so give it an opaque background too.
  const appleSize = 180
  const appleLogoSize = Math.round(appleSize * 0.7)
  const appleLogo = await sharp(svg, { density: 384 })
    .resize(appleLogoSize, appleLogoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
  await sharp({ create: { width: appleSize, height: appleSize, channels: 4, background: BG } })
    .composite([{ input: appleLogo, gravity: 'center' }])
    .png()
    .toFile(resolve(root, 'public/icons/apple-touch-icon.png'))
}

main()
  .then(() => console.log('Generated public/icons/*.png'))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
