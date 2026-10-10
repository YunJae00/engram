import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SS = 4 // supersampling factor for smooth edges

// A round plate in the app's own ink, the comet on it in white.
const PLATE = [0x2b, 0x2b, 0x33]
const MARK = [0xff, 0xff, 0xff]

// The comet: a five-point star leaning into flight, its tips rounded by a
// thick round-joined stroke, and three fading dots trailing down-left. Same
// numbers as the in-app mark (Icon.tsx) and the tray glyph (tray.ts), in the
// 24 grid they were drawn on.
const STAR = { cx: 13.9, cy: 10.1, R: 5.25, r: 3.2, sw: 2.25, tilt: (12 * Math.PI) / 180 }
const TRAIL = [
  [8.6, 15.4, 1.6],
  [5.8, 18.0, 1.15],
  [3.75, 20.05, 0.75],
]
// The mark's bounding box in grid units, used to centre it on the plate.
const MARK_BOX = { cx: 11.65, cy: 12.25, size: 17.3 }

const VERTS = Array.from({ length: 10 }, (_, k) => {
  const a = -Math.PI / 2 + (k * Math.PI) / 5 + STAR.tilt
  const rad = k % 2 === 0 ? STAR.R : STAR.r
  return [STAR.cx + rad * Math.cos(a), STAR.cy + rad * Math.sin(a)]
})

function inPoly(x, y) {
  let inside = false
  for (let i = 0, j = VERTS.length - 1; i < VERTS.length; j = i++) {
    const [xi, yi] = VERTS[i]
    const [xj, yj] = VERTS[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function edgeDist(x, y) {
  let best = Infinity
  for (let i = 0, j = VERTS.length - 1; i < VERTS.length; j = i++) {
    const [ax, ay] = VERTS[j]
    const [bx, by] = VERTS[i]
    const dx = bx - ax
    const dy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}

// 1 inside the comet, else 0. The body is the star polygon plus half the
// stroke around it, which is what rounds the tips. Below 32px the third dot
// is sub-pixel, so only two trail.
function cometAlpha(gx, gy, px) {
  if (inPoly(gx, gy) || edgeDist(gx, gy) <= STAR.sw / 2) return 1
  const dots = px < 32 ? 2 : 3
  for (let i = 0; i < dots; i++) {
    const [x, y, r] = TRAIL[i]
    if ((gx - x) ** 2 + (gy - y) ** 2 <= r * r) return 1
  }
  return 0
}

// Renders the round plate with the comet at `px` pixels; straight-alpha RGBA.
export function renderIcon(px) {
  const W = px * SS
  const half = W / 2
  const out = Buffer.alloc(px * px * 4)
  // Small icons get a bigger comet: at 16 and 24px the plate would swallow it.
  const fill = px <= 32 ? 0.7 : 0.56
  const scale = (W * fill) / MARK_BOX.size
  const offX = half - MARK_BOX.cx * scale
  const offY = half - MARK_BOX.cy * scale
  for (let oy = 0; oy < px; oy++) {
    for (let ox = 0; ox < px; ox++) {
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ox * SS + sx + 0.5
          const y = oy * SS + sy + 0.5
          if ((x - half) ** 2 + (y - half) ** 2 > half * half) continue
          const a = cometAlpha((x - offX) / scale, (y - offY) / scale, px)
          sumR += MARK[0] * a + PLATE[0] * (1 - a)
          sumG += MARK[1] * a + PLATE[1] * (1 - a)
          sumB += MARK[2] * a + PLATE[2] * (1 - a)
          sumA += 1
        }
      }
      const n = SS * SS
      const i = (oy * px + ox) * 4
      out[i] = sumA > 0 ? Math.round(sumR / sumA) : 0
      out[i + 1] = sumA > 0 ? Math.round(sumG / sumA) : 0
      out[i + 2] = sumA > 0 ? Math.round(sumB / sumA) : 0
      out[i + 3] = Math.round((sumA / n) * 255)
    }
  }
  return out
}

// ── PNG encoding ──────────────────────────────────────────────────
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function encodePng(px, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(px, 0)
  ihdr.writeUInt32BE(px, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(px * (px * 4 + 1))
  for (let y = 0; y < px; y++) {
    raw[y * (px * 4 + 1)] = 0
    rgba.copy(raw, y * (px * 4 + 1) + 1, y * px * 4, (y + 1) * px * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
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
// Each size is RENDERED, never downscaled: at 16px the comet has to be
// redrawn to stay legible, not resampled into mush.
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
