import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SS = 4 // supersampling factor for smooth edges

const STARLIGHT = [0xf4, 0xf6, 0xff]
// Night-sky tile: a shallow vertical gradient rather than a flat block, so the
// square reads as sky instead of as a generic dark app chip.
const TILE_TOP = [0x1b, 0x1e, 0x33]
const TILE_BOTTOM = [0x0d, 0x0f, 0x1c]
const TILE_RADIUS = 0.225 // corner radius as a fraction of the side

// The app's own character wears the icon: the pillowy five-point star from
// the comets, leaning into flight, with its face cut out so the sky shows
// through. The same proportions as the in-app mark, in fractions of the
// 24 grid it was drawn on.
const GRID = 24
const STAR = { cx: 12, cy: 12.6, R: 10.6, rIn: 7.0, puff: 0.58, tilt: (10 * Math.PI) / 180 }
const FACE = { cy: 12.0, eyeGap: 3.0, eyeR: 0.95, eyeRSmall: 1.25 }
const SMILE = { cy: 11.5, rm: 2.1, t: 0.9, span: 0.62 }
// Icons small enough that a smile would be a smudge keep the eyes alone,
// grown a touch - the same rule the in-app mark follows.
const FACE_DETAIL_MIN = 48
const GLOW = 1.1

// The silhouette is star-convex about its centre, so "inside" is one radius
// per direction: the outline (the same two quadratics per limb as the app
// mark) is sampled once into a direction -> radius table.
const LUT_BINS = 2048
const radiusAt = (() => {
  const pol = (r, a) => ({ x: r * Math.sin(a), y: -r * Math.cos(a) })
  const pts = []
  const step = (2 * Math.PI) / 5
  const { R, rIn, puff, tilt } = STAR
  const q = (p0, p1, p2, t) => ({
    x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
    y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
  })
  for (let i = 0; i < 5; i++) {
    const a = tilt + i * step
    const b = a + step / 2
    const bulge = rIn + (R - rIn) * puff
    const tip = pol(R * 0.98, a)
    const inP = pol(rIn, b)
    const tip2 = pol(R * 0.98, a + step)
    for (let t = 0; t <= 400; t++) pts.push(q(tip, pol(bulge, a + step / 4), inP, t / 400))
    for (let t = 0; t <= 400; t++) pts.push(q(inP, pol(bulge, b + step / 4), tip2, t / 400))
  }
  const lut = new Float64Array(LUT_BINS)
  for (const p of pts) {
    const theta = Math.atan2(p.y, p.x)
    const bin = Math.round(((theta + Math.PI) / (2 * Math.PI)) * (LUT_BINS - 1))
    const r = Math.hypot(p.x, p.y)
    if (r > lut[bin]) lut[bin] = r
  }
  // Fill any bin the sampling skipped from its neighbours - twice around,
  // so a run of empty bins at the seam is covered from either side.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < LUT_BINS; k++) {
      if (lut[k] === 0) lut[k] = Math.max(lut[(k - 1 + LUT_BINS) % LUT_BINS], lut[(k + 1) % LUT_BINS])
    }
  }
  // Read between bins, so the rim is a curve rather than a staircase.
  return (theta) => {
    const at = ((theta + Math.PI) / (2 * Math.PI)) * LUT_BINS
    const k = Math.floor(at) % LUT_BINS
    const frac = at - Math.floor(at)
    return lut[k] * (1 - frac) + lut[(k + 1) % LUT_BINS] * frac
  }
})()

// Inside the full-bleed rounded tile?
function inTile(x, y, W) {
  const half = W / 2
  const r = TILE_RADIUS * W
  const dx = Math.abs(x - half)
  const dy = Math.abs(y - half)
  if (dx > half || dy > half) return false
  if (dx <= half - r || dy <= half - r) return true
  return (dx - (half - r)) ** 2 + (dy - (half - r)) ** 2 <= r * r
}

// The star's coverage at one sample point, face holes and a soft halo
// included. Everything works in grid units about the star's centre.
function starAlpha(gx, gy, px) {
  const dx = gx - STAR.cx
  const dy = gy - STAR.cy
  const d = Math.hypot(dx, dy)
  const rim = radiusAt(Math.atan2(dy, dx))
  if (d <= rim) {
    const detailed = px >= FACE_DETAIL_MIN
    const eyeR = detailed ? FACE.eyeR : FACE.eyeRSmall
    for (const side of [-1, 1]) {
      const ex = STAR.cx + side * FACE.eyeGap
      if ((gx - ex) ** 2 + (gy - FACE.cy) ** 2 <= eyeR * eyeR) return 0
    }
    if (detailed) {
      const sdx = gx - STAR.cx
      const sdy = gy - SMILE.cy
      const sr = Math.hypot(sdx, sdy)
      const sa = Math.atan2(sdx, -sdy)
      const inBand = Math.abs(sr - SMILE.rm) <= SMILE.t / 2
      if (inBand && Math.abs(sa) >= Math.PI - SMILE.span) return 0
      for (const side of [-1, 1]) {
        const capA = Math.PI + side * SMILE.span
        const capX = STAR.cx + SMILE.rm * Math.sin(capA)
        const capY = SMILE.cy - SMILE.rm * Math.cos(capA)
        if ((gx - capX) ** 2 + (gy - capY) ** 2 <= (SMILE.t / 2) ** 2) return 0
      }
    }
    return 1
  }
  // A whisper of light just beyond the body, so the star sits IN the sky
  // rather than stamped on it.
  const outer = rim * GLOW
  if (d < outer) return ((1 - (d - rim) / (outer - rim)) ** 3) * 0.25
  return 0
}

// Renders the dark tile with the star at `px` pixels; straight-alpha RGBA.
export function renderIcon(px) {
  const W = px * SS
  const out = Buffer.alloc(px * px * 4)
  // The glyph fills most of the tile, its centre a touch high so the tilt
  // does not read as a slide toward the corner.
  const scale = (W * 0.86) / GRID
  const offX = W / 2 - STAR.cx * scale
  const offY = W * 0.485 - STAR.cy * scale
  for (let oy = 0; oy < px; oy++) {
    for (let ox = 0; ox < px; ox++) {
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ox * SS + sx
          const y = oy * SS + sy
          let cr = 0
          let cg = 0
          let cb = 0
          let ca = 0
          if (inTile(x, y, W)) {
            const glyphAlpha = starAlpha((x - offX) / scale, (y - offY) / scale, px)
            const g = y / W
            const tr = TILE_TOP[0] * (1 - g) + TILE_BOTTOM[0] * g
            const tg = TILE_TOP[1] * (1 - g) + TILE_BOTTOM[1] * g
            const tb = TILE_TOP[2] * (1 - g) + TILE_BOTTOM[2] * g
            cr = STARLIGHT[0] * glyphAlpha + tr * (1 - glyphAlpha)
            cg = STARLIGHT[1] * glyphAlpha + tg * (1 - glyphAlpha)
            cb = STARLIGHT[2] * glyphAlpha + tb * (1 - glyphAlpha)
            ca = 1
          }
          sumR += cr * ca
          sumG += cg * ca
          sumB += cb * ca
          sumA += ca
        }
      }
      const n = SS * SS
      const i = (oy * px + ox) * 4
      const alpha = sumA / n
      out[i] = alpha > 0 ? Math.round(sumR / sumA) : 0
      out[i + 1] = alpha > 0 ? Math.round(sumG / sumA) : 0
      out[i + 2] = alpha > 0 ? Math.round(sumB / sumA) : 0
      out[i + 3] = Math.round(alpha * 255)
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
// the space around it, so a full-bleed tile — correct on Windows — renders
// visibly larger than its neighbours in the Dock. Apple's grid: the rounded
// square covers 824 of a 1024 canvas (80.47%), centred, the rest transparent.
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
// icon pipeline, and recent macOS composites it onto a default light tile —
// which is the white frame around Engram's icon that no amount of redrawing
// the PNG could remove. actool compiles this set at package time
// (scripts/adhoc-sign.mjs); these are the sources it reads.
//
// Each size is RENDERED, never downscaled: at 16px the constellation has to
// be redrawn to stay legible, not resampled into mush.
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
