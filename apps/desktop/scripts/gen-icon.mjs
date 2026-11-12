import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng, loadMaster, resample } from './gen-engram-char-sizes.mjs'

const SS = 4 // supersampling factor for the plate's rounded corners

// 08-knob on a cream rounded square, nothing else: no gradient, glass or letter.
const PLATE = [0xf6, 0xf3, 0xee]
const CORNER = 0.225 // corner radius as a fraction of the side
export const MARGIN = 0.13 // per-side gap between the plate edge and the knob body
const knob = loadMaster('08-knob')

function bodyBox(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] < 128) continue
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

// A square window of `img` centred on the body, wide enough that the body fills 1 - 2*MARGIN of it.
function framed(img, box) {
  const side = Math.round((box.x1 - box.x0) / (1 - 2 * MARGIN))
  const left = Math.round((box.x0 + box.x1 - side) / 2)
  const top = Math.round((box.y0 + box.y1 - side) / 2)
  const data = Buffer.alloc(side * side * 4)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const sx = x + left, sy = y + top
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue
      img.data.copy(data, (y * side + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4)
    }
  }
  return { width: side, height: side, data }
}

const box = bodyBox(knob.flat)
const regularArt = framed(knob.flat, box)
const opticalArt = framed(knob.opt, box)

function plateCoverage(ox, oy, px) {
  const W = px * SS, half = W / 2, r = CORNER * W
  let n = 0
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const dx = Math.abs(ox * SS + sx + 0.5 - half), dy = Math.abs(oy * SS + sy + 0.5 - half)
      if (dx <= half - r || dy <= half - r || (dx - (half - r)) ** 2 + (dy - (half - r)) ** 2 <= r * r) n++
    }
  }
  return n / (SS * SS)
}

// Renders the plate with the knob at `px` pixels; straight-alpha RGBA. 24px and below use the optical face.
export function renderIcon(px) {
  const art = resample(px <= 24 ? opticalArt : regularArt, px).data
  const out = Buffer.alloc(px * px * 4)
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const i = (y * px + x) * 4
      const a = art[i + 3] / 255
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(art[i + c] * a + PLATE[c] * (1 - a))
      out[i + 3] = Math.round(plateCoverage(x, y, px) * 255)
    }
  }
  return out
}

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

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
mkdirSync(dir, { recursive: true })

const master = encodePng(512, renderIcon(512))
writeFileSync(join(dir, 'icon.png'), master)

// The same artwork, delivered the way macOS has expected since Big Sur: an
// asset catalog named by CFBundleIconName. A bundle carrying only the legacy
// CFBundleIconFile + .icns is treated as an app that never adopted the modern
// icon pipeline, and recent macOS composites it onto a default light tile.
// actool compiles this set at package time (scripts/adhoc-sign.mjs); these
// are the sources it reads.
//
// Each size is rendered from the 1024 masters, the optical face at 24px and below.
const APPICON_SIZES = [16, 32, 128, 256, 512]

function writeAppIconSet(root) {
  const set = join(root, 'AppIcon.appiconset')
  mkdirSync(set, { recursive: true })
  const images = []
  for (const size of APPICON_SIZES) {
    for (const scale of [1, 2]) {
      const px = size * scale
      const file = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      // Same 824-of-1024 grid at every size — the margin is proportional.
      const body = Math.round((px * MAC_BODY) / MAC_CANVAS)
      writeFileSync(join(set, file), encodePng(px, padCanvas(renderIcon(body), body, px)))
      images.push({ size: `${size}x${size}`, idiom: 'mac', filename: file, scale: `${scale}x` })
    }
  }
  writeFileSync(join(set, 'Contents.json'), JSON.stringify({ images, info: { version: 1, author: 'engram' } }, null, 2))
  return set
}

const mac = encodePng(MAC_CANVAS, padCanvas(renderIcon(MAC_BODY), MAC_BODY, MAC_CANVAS))
writeFileSync(join(dir, 'icon-mac.png'), mac)

const icoSizes = [256, 128, 64, 48, 32, 24, 16]
const ico = encodeIco(icoSizes.map((px) => ({ px, png: encodePng(px, renderIcon(px)) })))
writeFileSync(join(dir, 'icon.ico'), ico)
const appIconSet = writeAppIconSet(join(dir, 'Engram.xcassets'))
console.log(
  `icons written: icon.png (${master.length} bytes) + icon-mac.png (${mac.length} bytes, ${MAC_BODY}/${MAC_CANVAS} grid) + icon.ico (${ico.length} bytes, ${icoSizes.join('/')}px) + ${appIconSet}`,
)
