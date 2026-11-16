import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng, resample } from './gen-engram-char-sizes.mjs'
import { renderMaster } from './icon-art.mjs'

// Usage: node scripts/gen-icon.mjs [--preview <dir>]
// --preview also writes the full-bleed and Dock-grid 1024 PNGs, 128/64/32/16 previews and (on macOS) Engram.icns into <dir>, for review.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const regular = renderMaster()
const small = renderMaster({ small: true })
// The thin arcs vanish when scaled down, so small bodies use the master that draws them thicker.
const SMALL_MAX = 48

export const renderIcon = (px) => resample(px <= SMALL_MAX ? small : regular, px).data

// ── ICO container (PNG-compressed entries, Vista+) ────────────────
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  const blobs = []
  let offset = 6 + entries.length * 16
  for (const { px, png } of entries) {
    const dir = Buffer.alloc(16)
    dir[0] = px >= 256 ? 0 : px
    dir[1] = px >= 256 ? 0 : px
    dir[2] = 0
    dir[3] = 0
    dir.writeUInt16LE(1, 4)
    dir.writeUInt16LE(32, 6)
    dir.writeUInt32LE(png.length, 8)
    dir.writeUInt32LE(offset, 12)
    dirs.push(dir)
    blobs.push(png)
    offset += png.length
  }
  return Buffer.concat([header, ...dirs, ...blobs])
}

// macOS sizes every app icon to the same grid and draws the system shadow in
// the space around it, so a full-bleed plate — correct on Windows — renders
// visibly larger than its neighbours in the Dock. Apple's grid: the icon body
// covers 824 of a 1024 canvas (80.47%), centred, the rest transparent.
const MAC_CANVAS = 1024
const MAC_BODY = 824

// Centre a square RGBA bitmap on a larger transparent canvas.
function padCanvas(rgba, srcPx, dstPx) {
  const out = Buffer.alloc(dstPx * dstPx * 4)
  const offset = Math.round((dstPx - srcPx) / 2)
  for (let y = 0; y < srcPx; y++) {
    rgba.copy(out, ((y + offset) * dstPx + offset) * 4, y * srcPx * 4, (y + 1) * srcPx * 4)
  }
  return out
}

// The same artwork, delivered the way macOS has expected since Big Sur: an
// asset catalog named by CFBundleIconName. A bundle carrying only the legacy
// CFBundleIconFile + .icns is treated as an app that never adopted the modern
// icon pipeline, and recent macOS composites it onto a default light tile.
// actool compiles this set at package time (scripts/adhoc-sign.mjs); these
// are the sources it reads.
const APPICON_SIZES = [16, 32, 128, 256, 512]
const icoSizes = [256, 128, 64, 48, 32, 24, 16]

// Every bitmap is rendered before the first write, so a bad SVG leaves the committed files untouched.
const png512 = encodePng(512, renderIcon(512))
const mac = encodePng(MAC_CANVAS, padCanvas(renderIcon(MAC_BODY), MAC_BODY, MAC_CANVAS))
const ico = encodeIco(icoSizes.map((px) => ({ px, png: encodePng(px, renderIcon(px)) })))
const catalog = APPICON_SIZES.flatMap((size) => [1, 2].map((scale) => {
  const px = size * scale
  // Same 824-of-1024 grid at every size — the margin is proportional.
  const body = Math.round((px * MAC_BODY) / MAC_CANVAS)
  return { size, scale, file: `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`, png: encodePng(px, padCanvas(renderIcon(body), body, px)) }
}))

const set = join(dir, 'Engram.xcassets', 'AppIcon.appiconset')
mkdirSync(set, { recursive: true })
writeFileSync(join(dir, 'icon.png'), png512)
writeFileSync(join(dir, 'icon-mac.png'), mac)
writeFileSync(join(dir, 'icon.ico'), ico)
for (const { file, png } of catalog) writeFileSync(join(set, file), png)
const images = catalog.map(({ size, scale, file }) => ({ size: `${size}x${size}`, idiom: 'mac', filename: file, scale: `${scale}x` }))
writeFileSync(join(set, 'Contents.json'), JSON.stringify({ images, info: { version: 1, author: 'engram' } }, null, 2))
const at = process.argv.indexOf('--preview')
if (at > 0) {
  if (!process.argv[at + 1]) throw new Error('gen-icon: --preview needs a directory')
  const preview = resolve(process.argv[at + 1])
  // The catalog files already carry the names iconutil expects of an iconset.
  const iconset = join(preview, 'Engram.iconset')
  mkdirSync(iconset, { recursive: true })
  writeFileSync(join(preview, 'appicon-1024.png'), encodePng(1024, regular.data))
  writeFileSync(join(preview, 'appicon-mac-1024.png'), mac)
  for (const { file, png } of catalog) writeFileSync(join(iconset, file), png)
  for (const px of [128, 64, 32, 16]) writeFileSync(join(preview, `appicon-${px}.png`), encodePng(px, renderIcon(px)))
  if (process.platform === 'darwin') execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(preview, 'Engram.icns')])
  console.log(`preview written: ${preview}`)
}
console.log(
  `icons written: icon.png (${png512.length} bytes) + icon-mac.png (${mac.length} bytes, ${MAC_BODY}/${MAC_CANVAS} grid) + icon.ico (${ico.length} bytes, ${icoSizes.join('/')}px) + ${set}`,
)
