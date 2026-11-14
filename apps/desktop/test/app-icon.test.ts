import { readFileSync } from 'node:fs'
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
const violet = (img: Img, i: number) => img.data[i + 3] === 255 && img.data[i + 2] >= 60 && img.data[i + 2] - img.data[i + 1] >= 20 && img.data[i] >= img.data[i + 1]
const at = (img: Img, x: number, y: number) => (y * img.width + x) * 4

it('draws the violet earthrise on a black rounded square', () => {
  const icons: Img[] = [decodePng(readFileSync(new URL('../build/icon.png', import.meta.url)), 'icon.png'), ...[256, 128, 64, 48, 32, 24, 16].map(icoEntry)]
  for (const img of icons) {
    const W = img.width
    for (const [x, y] of [[1, W >> 1], [W >> 1, W - 2]]) {
      expect(img.data[at(img, x, y) + 3], `${W}px opaque at ${x},${y}`).toBe(255)
      expect(lum(img, at(img, x, y)), `${W}px black at ${x},${y}`).toBeLessThan(24)
    }
    expect(img.data[3], `${W}px rounded corner`).toBe(0)
    let count = 0, highlight = 0
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      if (y < W / 4) highlight = Math.max(highlight, lum(img, at(img, x, y)))
      if (!violet(img, at(img, x, y))) continue
      count++
      expect(y, `${W}px violet row`).toBeGreaterThanOrEqual(Math.floor(0.35 * W))
      expect(y, `${W}px violet row`).toBeLessThanOrEqual(Math.ceil(0.8 * W))
    }
    expect(count, `${W}px violet arc`).toBeGreaterThanOrEqual(Math.max(3, W * W * 0.004))
    expect(highlight, `${W}px has no highlight in the top quarter`).toBeLessThan(40)
  }
  const mac = decodePng(readFileSync(new URL('../build/icon-mac.png', import.meta.url)), 'icon-mac.png')
  expect(mac.data[at(mac, 110, 512) + 3]).toBe(255)
  expect(lum(mac, at(mac, 110, 512))).toBeLessThan(24)
  expect(mac.data[at(mac, 50, 512) + 3]).toBe(0)
})

it('keeps the arc visible at 16px and 16@2x', () => {
  const set = new URL('../build/Engram.xcassets/AppIcon.appiconset/', import.meta.url)
  for (const img of [decodePng(readFileSync(new URL('icon_16x16.png', set)), '16'), decodePng(readFileSync(new URL('icon_16x16@2x.png', set)), '16@2x'), icoEntry(16), icoEntry(32)]) {
    const W = img.width
    let low = 255, high = 0, count = 0
    const rows = new Array<number>(W).fill(0)
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const i = at(img, x, y)
      if (img.data[i + 3] !== 255) continue
      const v = lum(img, i)
      low = Math.min(low, v); high = Math.max(high, v); rows[y] = Math.max(rows[y]!, v)
      if (violet(img, i)) count++
    }
    expect(high - low, `${W}px is not a flat tile`).toBeGreaterThanOrEqual(70)
    expect(count, `${W}px violet`).toBeGreaterThanOrEqual(W === 16 ? 3 : 8)
    const columns = new Set<number>()
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (img.data[at(img, x, y) + 3] === 255 && lum(img, at(img, x, y)) >= high / 2) columns.add(x)
    expect(columns.size, `${W}px arc width`).toBeGreaterThanOrEqual(W / 4)
    const brightest = rows.indexOf(Math.max(...rows))
    expect(brightest / W, `${W}px arc row`).toBeGreaterThanOrEqual(0.4)
    expect(brightest / W, `${W}px arc row`).toBeLessThanOrEqual(0.75)
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
