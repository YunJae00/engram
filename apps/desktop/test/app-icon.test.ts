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

it('ships transparent round artwork at every declared desktop size', () => {
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
