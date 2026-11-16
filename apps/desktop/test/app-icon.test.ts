import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'

const bitmaps = vi.hoisted(() => [] as { buffer: Buffer; width: number; height: number; scaleFactor?: number }[])
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn() },
  Tray: class { setToolTip = vi.fn(); setContextMenu = vi.fn(); on = vi.fn() },
  nativeImage: {
    createFromBitmap(buffer: Buffer, dimensions: { width: number; height: number }) {
      bitmaps.push({ buffer, ...dimensions })
      return {
        addRepresentation(image: (typeof bitmaps)[number]) { bitmaps.push(image) },
        setTemplateImage: vi.fn(),
      }
    },
  },
}))
import { createTray } from '../src/main/tray.js'
import { decodePng } from '../scripts/gen-engram-char-sizes.mjs'
import { rasterize } from '../scripts/svg-raster.mjs'
import { writeFullIcns } from '../scripts/adhoc-sign.mjs'

function png(buffer: Buffer) {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  expect(buffer[24]).toBe(8)
  expect(buffer[25]).toBe(6)
  const parts: Buffer[] = []
  for (let offset = 8; offset < buffer.length;) {
    const size = buffer.readUInt32BE(offset)
    if (buffer.toString('ascii', offset + 4, offset + 8) === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + size))
    offset += 12 + size
  }
  const rows = inflateSync(Buffer.concat(parts))
  expect(rows.length).toBe(height * (width * 4 + 1))
  for (let row = 0; row < height; row++) expect(rows[row * (width * 4 + 1)]).toBe(0)
  const alpha = (x: number, y: number) => rows[y * (width * 4 + 1) + 1 + x * 4 + 3]
  expect(alpha(0, 0)).toBe(0)
  expect(alpha(width - 1, height - 1)).toBe(0)
  expect(alpha(Math.floor(width / 2), Math.floor(height / 2))).toBe(255)
  return { width, height }
}

it('ships transparent rounded-square artwork at every declared desktop size', () => {
  const build = new URL('../build/', import.meta.url)
  expect(png(readFileSync(new URL('icon.png', build)))).toEqual({ width: 512, height: 512 })
  expect(png(readFileSync(new URL('icon-mac.png', build)))).toEqual({ width: 1024, height: 1024 })
  const set = new URL('Engram.xcassets/AppIcon.appiconset/', build)
  const catalog = JSON.parse(readFileSync(new URL('Contents.json', set), 'utf8')) as {
    images: { size: string; scale: string; filename: string }[]
  }
  expect(catalog.images).toHaveLength(10)
  for (const image of catalog.images) {
    const size = Number.parseInt(image.size) * Number.parseInt(image.scale)
    expect(png(readFileSync(new URL(image.filename, set)))).toEqual({ width: size, height: size })
  }
  const ico = readFileSync(new URL('icon.ico', build))
  expect(ico.readUInt16LE(0)).toBe(0)
  expect(ico.readUInt16LE(2)).toBe(1)
  const sizes = [256, 128, 64, 48, 32, 24, 16]
  expect(ico.readUInt16LE(4)).toBe(sizes.length)
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16
    expect(ico[entry] || 256).toBe(size)
    expect(ico[entry + 1] || 256).toBe(size)
    const offset = ico.readUInt32LE(entry + 12)
    const length = ico.readUInt32LE(entry + 8)
    expect(offset + length).toBeLessThanOrEqual(ico.length)
    expect(png(ico.subarray(offset, offset + length))).toEqual({ width: size, height: size })
  }
})

// S29: the bundle's AppIcon.icns stopped at 256. iconutil ships with macOS only.
it.skipIf(process.platform !== 'darwin')('builds AppIcon.icns as a complete set, 16 through 1024, from the catalog artwork', () => {
  const set = fileURLToPath(new URL('../build/Engram.xcassets/AppIcon.appiconset/', import.meta.url))
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  mkdirSync(tmp, { recursive: true })
  const work = mkdtempSync(join(tmp, 'app-icon-icns-'))
  const out = join(work, 'AppIcon.icns')
  writeFullIcns(set, out, work)
  const icns = readFileSync(out)
  expect(icns.toString('ascii', 0, 4)).toBe('icns')
  // icns entry types: ic04/ic05 are 16/32 (packed ARGB), ic07–ic10 are 128–1024, ic11–ic14 the @2x of 16/32/128/256.
  const files: Record<string, string> = { ic07: '128x128', ic08: '256x256', ic09: '512x512', ic10: '512x512@2x', ic11: '16x16@2x', ic12: '32x32@2x', ic13: '128x128@2x', ic14: '256x256@2x' }
  const types: string[] = []
  for (let offset = 8; offset < icns.length; offset += icns.readUInt32BE(offset + 4)) {
    const type = icns.toString('ascii', offset, offset + 4)
    types.push(type)
    if (!files[type]) continue
    // iconutil may re-encode, so the pixels are compared, not the bytes.
    const file = `icon_${files[type]}.png`
    expect(decodePng(icns.subarray(offset + 8, offset + icns.readUInt32BE(offset + 4)), type).data.equals(decodePng(readFileSync(join(set, file)), file).data), `${type} is ${file}`).toBe(true)
  }
  expect(types.filter(type => type !== 'info').sort()).toEqual(['ic04', 'ic05', ...Object.keys(files)].sort())
})

it('draws visible transparent tray glyphs for standard and high-density displays', () => {
  bitmaps.length = 0
  createTray({ onOpen: vi.fn(), onQuickCapture: vi.fn(), onQuit: vi.fn(), onInstallUpdate: vi.fn() })
  expect(bitmaps.map(({ width, height }) => [width, height])).toEqual([[16, 16], [32, 32]])
  expect(bitmaps[1]?.scaleFactor).toBe(2)
  for (const { buffer, width, height } of bitmaps) {
    expect(buffer.length).toBe(width * height * 4)
    const alpha = [...buffer].filter((_, index) => index % 4 === 3)
    expect(alpha[0]).toBe(0)
    expect(alpha.at(-1)).toBe(0)
    expect(alpha.filter(value => value === 255).length).toBeGreaterThan(width * height / 5)
    expect(alpha.some(value => value > 0 && value < 255)).toBe(true)
  }
})

type Img = { width: number; height: number; data: Buffer }

function icoEntry(size: number): Img {
  const ico = readFileSync(new URL('../build/icon.ico', import.meta.url))
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    const entry = 6 + index * 16
    if ((ico[entry] || 256) !== size) continue
    const offset = ico.readUInt32LE(entry + 12)
    return decodePng(ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)), `ico ${size}`)
  }
  throw new Error(`icon.ico has no ${size}px entry`)
}

const lum = (img: Img, i: number) => (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000
const at = (img: Img, x: number, y: number) => (y * img.width + x) * 4
const opaque = (img: Img, i: number) => img.data[i + 3] === 255
// The arcs' two spectral fringes: peach outside the circle, blue inside it.
const warm = (img: Img, i: number) => opaque(img, i) && img.data[i] - img.data[i + 2] >= 30
const cool = (img: Img, i: number) => opaque(img, i) && img.data[i + 2] - img.data[i] >= 20
// The brightest row of the centre column in the top half: the crest of the top arc.
function crest(img: Img) {
  const x = img.width >> 1
  const column = Array.from({ length: img.width >> 1 }, (_, y) => opaque(img, at(img, x, y)) ? lum(img, at(img, x, y)) : 0)
  return column.indexOf(Math.max(...column))
}
// A half turn about the centre of the plate.
const turned = (img: Img, x: number, y: number) => at(img, img.width - 1 - x, img.width - 1 - y)

it('draws twin arcs of light on a charcoal rounded square: equal top and bottom, unchanged by a half turn, no sphere', () => {
  const icons: Img[] = [decodePng(readFileSync(new URL('../build/icon.png', import.meta.url)), 'icon.png'), ...[256, 128, 64, 48, 32, 24, 16].map(icoEntry)]
  for (const img of icons) {
    const W = img.width, centre = W >> 1
    for (const [x, y] of [[0, centre], [W - 1, centre], [centre, 0], [centre, W - 1]]) {
      const i = at(img, x!, y!)
      expect(img.data[i + 3], `${W}px opaque at ${x},${y}`).toBe(255)
      expect(lum(img, i), `${W}px charcoal at ${x},${y}`).toBeLessThan(60)
      expect(Math.abs(img.data[i] - img.data[i + 2]), `${W}px neutral plate at ${x},${y}`).toBeLessThanOrEqual(4)
    }
    expect(img.data[3], `${W}px rounded corner`).toBe(0)
    // 180-degree rotational symmetry, pixel for pixel: the bottom arc is the top arc turned, with the same thickness, brightness, taper and fringes.
    let off = 0
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) off = Math.max(off, Math.abs(img.data[at(img, x, y) + k] - img.data[turned(img, x, y) + k]))
    expect(off, `${W}px is unchanged by a half turn`).toBeLessThanOrEqual(2)
    // The top arc's crest sits on the circle (radius 330/1024 of the plate), and the half turn puts its twin at the bottom.
    const row = crest(img)
    expect(row / W, `${W}px top arc row`).toBeGreaterThanOrEqual(0.12)
    expect(row / W, `${W}px top arc row`).toBeLessThanOrEqual(0.25)
    expect(lum(img, at(img, centre, row)), `${W}px soft white top arc`).toBeGreaterThanOrEqual(190)
    expect(lum(img, turned(img, centre, row)), `${W}px soft white bottom arc`).toBeGreaterThanOrEqual(190)
    // Two equal gaps: the circle is dark at the left and at the right. No closed rim.
    const radius = centre - row
    for (const x of [centre - radius, centre + radius]) for (const dy of [-0.06, 0, 0.06]) expect(lum(img, at(img, x, centre + Math.round(W * dy))), `${W}px gap at ${x},${dy}`).toBeLessThan(60)
    // No sphere, no earthrise bowl: the plate shows through everywhere between the arcs.
    for (const y of [0.38, 0.44, 0.5, 0.56, 0.62]) for (const x of [0.38, 0.5, 0.62]) expect(lum(img, at(img, Math.round(W * x), Math.round(W * y))), `${W}px empty middle at ${x},${y}`).toBeLessThan(60)
    let tinted = 0, bright = 0, n = 0
    for (let i = 0; i < img.data.length; i += 4) {
      if (!opaque(img, i)) continue
      n++
      if (warm(img, i) || cool(img, i)) tinted++
      if (lum(img, i) >= 200) bright++
    }
    // The small master (48px and under) draws the fringes thicker, so more of it is tinted.
    expect(tinted / n, `${W}px is monochrome with small spectral accents`).toBeLessThan(W <= 48 ? 0.16 : 0.08)
    expect(bright / n, `${W}px has no large bright blob`).toBeLessThan(W <= 48 ? 0.12 : 0.04)
  }
  // At a size where the fringes resolve: peach sits outside the white core and blue inside it, on both arcs.
  const big = icons[0]!
  const row = crest(big), x = big.width >> 1
  const outer = Array.from({ length: 24 }, (_, k) => [x, row - 1 - k] as const), inner = Array.from({ length: 24 }, (_, k) => [x, row + 1 + k] as const)
  for (const [name, pick] of [['top', (px: number, py: number) => at(big, px, py)], ['bottom', (px: number, py: number) => turned(big, px, py)]] as const) {
    expect(outer.some(([px, py]) => warm(big, pick(px, py))), `peach outside the ${name} arc`).toBe(true)
    expect(inner.some(([px, py]) => cool(big, pick(px, py))), `blue inside the ${name} arc`).toBe(true)
    expect(outer.some(([px, py]) => cool(big, pick(px, py))) || inner.some(([px, py]) => warm(big, pick(px, py))), `${name} fringes keep their sides`).toBe(false)
  }
  const mac = decodePng(readFileSync(new URL('../build/icon-mac.png', import.meta.url)), 'icon-mac.png')
  expect(mac.data[at(mac, 110, 512) + 3]).toBe(255)
  expect(lum(mac, at(mac, 110, 512))).toBeLessThan(60)
  expect(mac.data[at(mac, 50, 512) + 3]).toBe(0)
})

it('keeps both arcs visible at 16px and 16@2x', () => {
  const set = new URL('../build/Engram.xcassets/AppIcon.appiconset/', import.meta.url)
  for (const img of [decodePng(readFileSync(new URL('icon_16x16.png', set)), '16'), decodePng(readFileSync(new URL('icon_16x16@2x.png', set)), '16@2x'), icoEntry(16), icoEntry(32)]) {
    const W = img.width
    let low = 255, high = 0
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const i = at(img, x, y)
      if (!opaque(img, i)) continue
      const v = lum(img, i)
      low = Math.min(low, v); high = Math.max(high, v)
    }
    expect(high - low, `${W}px is not a flat tile`).toBeGreaterThanOrEqual(70)
    // Each half holds an arc at least a quarter of the tile wide, with the plate between them.
    for (const [name, from, to] of [['top', 0, W >> 1], ['bottom', W >> 1, W]] as const) {
      const columns = new Set<number>()
      for (let y = from; y < to; y++) for (let x = 0; x < W; x++) if (opaque(img, at(img, x, y)) && lum(img, at(img, x, y)) >= high / 2) columns.add(x)
      expect(columns.size, `${W}px ${name} arc width`).toBeGreaterThanOrEqual(W / 4)
    }
    expect(lum(img, at(img, W >> 1, W >> 1)), `${W}px plate between the arcs`).toBeLessThan(high / 2)
  }
})

it('rasterizes the supported SVG subset and refuses the rest', () => {
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${inner}</svg>`
  const body = '<rect id="body" width="8" height="8" rx="0" fill="#000000"/>'
  const grad = '<defs><radialGradient id="g" cx="4" cy="4" r="4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></radialGradient></defs>'
  const img = rasterize(svg(`${grad}${body}<circle cx="4" cy="4" r="3" fill="url(#g)"/>`), 8, 1) as Img
  expect([img.width, img.height, img.data.length]).toEqual([8, 8, 256])
  const t = Math.sqrt(0.5) / 4
  expect([...img.data.subarray(at(img, 4, 4), at(img, 4, 4) + 4)]).toEqual([Math.round(255 * (1 - t)), 0, Math.round(255 * t), 255])
  expect([...img.data.subarray(0, 4)]).toEqual([0, 0, 0, 255])
  const round = rasterize(svg('<rect id="body" width="8" height="8" rx="4" fill="#102030"/>'), 8, 1) as Img
  expect([...round.data.subarray(0, 4)]).toEqual([0, 0, 0, 0])
  expect([...round.data.subarray(at(round, 4, 4), at(round, 4, 4) + 4)]).toEqual([0x10, 0x20, 0x30, 255])
  expect(() => rasterize(svg(`${body}<path d="M0 0"/>`))).toThrow('unsupported <path>')
  expect(() => rasterize(svg(`${body}<circle cx="4" cy="4" r="2" fill="#ffffff" filter="url(#f)"/>`))).toThrow('unsupported attribute filter on circle')
  expect(() => rasterize(svg('<circle cx="4" cy="4" r="2" fill="#ffffff"/>'))).toThrow('<rect id="body">')
  expect(() => rasterize(svg(`${body}<circle cx="4" cy="4" r="2" fill="url(#missing)"/>`))).toThrow('unknown gradient missing')
  expect(() => rasterize(svg(`${body}<circle cx="4" cy="x" r="2" fill="#ffffff"/>`))).toThrow('bad cy')
  expect(() => rasterize('<svg viewBox="0 0 8 4"><rect id="body" width="8" height="4" fill="#000000"/></svg>')).toThrow('viewBox')
})
