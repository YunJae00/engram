import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SS = 4 // supersampling factor for smooth edges

const STARLIGHT = [0xf4, 0xf6, 0xff]
// Recently-recalled memories wear a gold halo in the app; the icon speaks the
// same vocabulary so one star is warm and the rest are starlight.
const GILD = [0xe8, 0xb4, 0x4a]
// Night-sky tile: a shallow vertical gradient rather than a flat block, so the
// square reads as sky instead of as a generic dark app chip.
const TILE_TOP = [0x1b, 0x1e, 0x33]
const TILE_BOTTOM = [0x0d, 0x0f, 0x1c]
const TILE_RADIUS = 0.225 // corner radius as a fraction of the side
const GLYPH_SCALE = 0.82
const LINK_ALPHA = 0.5

// The constellation IS the product: memories as stars whose BRIGHTNESS is how
// strongly each is held. One vivid anchor, one recently-recalled gold, two
// settled, one nearly faded — the whole memory model in five dots. Kept to
// five so it still reads at 16px.
export const GLYPH = {
  stars: [
    { x: 0.32, y: 0.63, r: 0.135, alpha: 1, glow: 1.75 },
    { x: 0.755, y: 0.265, r: 0.105, alpha: 1, warm: true, glow: 1.8 },
    { x: 0.185, y: 0.245, r: 0.072, alpha: 0.85, glow: 1.45 },
    { x: 0.83, y: 0.745, r: 0.066, alpha: 0.62 },
    { x: 0.565, y: 0.475, r: 0.052, alpha: 0.34 },
  ],
  edges: [
    [0, 2],
    [0, 4],
    [4, 1],
    [1, 3],
  ],
  edgeW: 0.042,
}

function segDist2(x, y, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)))
  const dx = x - (ax + vx * t)
  const dy = y - (ay + vy * t)
  return dx * dx + dy * dy
}

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

// Renders the dark tile with the white constellation at `px` pixels;
// returns straight-alpha RGBA.
export function renderIcon(px, layout) {
  const W = px * SS
  const nodes = layout.stars.map((s) => ({ x: s.x * W, y: s.y * W }))
  const edges = layout.edges.map(([a, b]) => [nodes[a], nodes[b]])
  const out = Buffer.alloc(px * px * 4)
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
            // Sample the INSET glyph: testing p against the glyph scaled by
            // GLYPH_SCALE about the centre == testing the un-scaled glyph at
            // centre + (p - centre)/scale.
            const gx = W / 2 + (x - W / 2) / GLYPH_SCALE
            const gy = W / 2 + (y - W / 2) / GLYPH_SCALE
            let glyphAlpha = 0
            let ink = STARLIGHT
            for (const s of layout.stars) {
              const dx = gx - s.x * W
              const dy = gy - s.y * W
              if (dx * dx + dy * dy <= (s.r * W) ** 2) {
                glyphAlpha = s.alpha
                if (s.warm) ink = GILD
                break
              }
            }
            if (glyphAlpha === 0) {
              for (const [n0, n1] of edges) {
                const rr = (layout.edgeW / 2) * W
                if (segDist2(gx, gy, n0.x, n0.y, n1.x, n1.y) <= rr * rr) {
                  glyphAlpha = LINK_ALPHA
                  break
                }
              }
            }
            // Lit stars bleed light into the sky around them — what separates a
            // night sky from a node diagram, and what says "this one is vivid".
            if (glyphAlpha === 0) {
              for (const st of layout.stars) {
                if (!st.glow) continue
                const dx = gx - st.x * W
                const dy = gy - st.y * W
                const d = Math.sqrt(dx * dx + dy * dy)
                const inner = st.r * W
                const outer = inner * st.glow
                if (d >= outer) continue
                const fall = (1 - (d - inner) / (outer - inner)) ** 3.2
                const a = fall * 0.3 * st.alpha
                if (a > glyphAlpha) {
                  glyphAlpha = a
                  ink = st.warm ? GILD : STARLIGHT
                }
              }
            }
            const g = y / W
            const tr = TILE_TOP[0] * (1 - g) + TILE_BOTTOM[0] * g
            const tg = TILE_TOP[1] * (1 - g) + TILE_BOTTOM[1] * g
            const tb = TILE_TOP[2] * (1 - g) + TILE_BOTTOM[2] * g
            cr = ink[0] * glyphAlpha + tr * (1 - glyphAlpha)
            cg = ink[1] * glyphAlpha + tg * (1 - glyphAlpha)
            cb = ink[2] * glyphAlpha + tb * (1 - glyphAlpha)
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

const master = encodePng(512, renderIcon(512, GLYPH))
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
      writeFileSync(join(set, file), encodePng(px, padCanvas(renderIcon(body, GLYPH), body, px)))
      images.push({ size: `${size}x${size}`, idiom: 'mac', filename: file, scale: `${scale}x` })
    }
  }
  writeFileSync(join(set, 'Contents.json'), JSON.stringify({ images, info: { version: 1, author: 'engram' } }, null, 2))
  return set
}

const mac = encodePng(MAC_CANVAS, padCanvas(renderIcon(MAC_BODY, GLYPH), MAC_BODY, MAC_CANVAS))
writeFileSync(join(dir, 'icon-mac.png'), mac)

const icoSizes = [256, 128, 64, 48, 32, 24, 16]
const ico = encodeIco(icoSizes.map((px) => ({ px, png: encodePng(px, renderIcon(px, GLYPH)) })))
writeFileSync(join(dir, 'icon.ico'), ico)
const appIconSet = writeAppIconSet(join(dir, 'Engram.xcassets'))
console.log(
  `icons written: icon.png (${master.length} bytes) + icon-mac.png (${mac.length} bytes, ${MAC_BODY}/${MAC_CANVAS} grid) + icon.ico (${ico.length} bytes, ${icoSizes.join('/')}px) + ${appIconSet}`,
)
