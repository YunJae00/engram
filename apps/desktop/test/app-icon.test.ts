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

// A knob pixel: opaque and visibly off the #F6F3EE plate (the body is #F3EEE9 with darker shaded edges).
const onKnob = (img: Img, x: number, y: number) => {
  const i = (y * img.width + x) * 4
  return img.data[i + 3] === 255 && (Math.abs(img.data[i] - 0xf6) >= 4 || Math.abs(img.data[i + 2] - 0xee) >= 4)
}

it('puts 08-knob on a flat cream rounded square with 12-14% side margins', () => {
  const icons: Img[] = [decodePng(readFileSync(new URL('../build/icon.png', import.meta.url)), 'icon.png'), ...[256, 128, 64, 48, 32, 24, 16].map(icoEntry)]
  for (const img of icons) {
    const W = img.width
    const plate = img.data.subarray((Math.floor(W / 2) * W + 1) * 4, (Math.floor(W / 2) * W + 1) * 4 + 4)
    expect([...plate], `${W}px plate`).toEqual([0xf6, 0xf3, 0xee, 255])
    expect(img.data[3], `${W}px rounded corner`).toBe(0)
    const columns = Array.from({ length: W }, (_, x) => x).filter(x => Array.from({ length: W }, (_, y) => y).some(y => onKnob(img, x, y)))
    expect(columns[0] / W, `${W}px left margin`).toBeGreaterThanOrEqual(0.12)
    expect(columns[0] / W, `${W}px left margin`).toBeLessThanOrEqual(0.14)
    expect((W - 1 - columns.at(-1)!) / W, `${W}px right margin`).toBeGreaterThanOrEqual(0.12)
    expect((W - 1 - columns.at(-1)!) / W, `${W}px right margin`).toBeLessThanOrEqual(0.14)
  }
  const mac = decodePng(readFileSync(new URL('../build/icon-mac.png', import.meta.url)), 'icon-mac.png')
  expect([...mac.data.subarray((512 * 1024 + 110) * 4, (512 * 1024 + 110) * 4 + 4)]).toEqual([0xf6, 0xf3, 0xee, 255])
})

it('keeps the knob bump readable at 32px', () => {
  const set = new URL('../build/Engram.xcassets/AppIcon.appiconset/', import.meta.url)
  for (const img of [icoEntry(32), decodePng(readFileSync(new URL('icon_16x16@2x.png', set)), '16@2x'), decodePng(readFileSync(new URL('icon_32x32.png', set)), '32')]) {
    const top = (x: number) => Array.from({ length: 32 }, (_, y) => y).find(y => onKnob(img, x, y)) ?? 32
    const crown = Math.min(top(15), top(16))
    expect(top(9) - crown, 'bump rises above the left shoulder').toBeGreaterThanOrEqual(3)
    expect(top(22) - crown, 'bump rises above the right shoulder').toBeGreaterThanOrEqual(3)
  }
})
