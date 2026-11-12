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

it('tray glyph is the 08-knob silhouette', () => {
  createTray({ onOpen: vi.fn(), onQuickCapture: vi.fn(), onQuit: vi.fn(), onInstallUpdate: vi.fn() })
  expect(bitmaps.map(({ width, height }) => [width, height])).toEqual([[16, 16], [32, 32]])
  expect(bitmaps[1]?.scaleFactor).toBe(2)
  for (const { buffer, width: size } of bitmaps) {
    const alpha = (x: number, y: number) => buffer[(y * size + x) * 4 + 3]!
    expect(alpha(size / 2, size / 2)).toBe(255)
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]] as const) expect(alpha(x, y)).toBe(0)
    const shade = buffer[0]
    for (let i = 0; i < buffer.length; i += 4) expect([buffer[i], buffer[i + 1], buffer[i + 2]]).toEqual([shade, shade, shade])
    let [minX, minY, maxX, maxY] = [size, size, -1, -1]
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (alpha(x, y) < 128) continue
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      }
    }
    const w = maxX - minX + 1
    expect(w).toBeGreaterThanOrEqual(maxY - minY + 1)
    expect(w).toBeGreaterThanOrEqual(0.85 * size)
    const top = (x: number) => {
      for (let y = 0; y < size; y++) if (alpha(x, y) >= 128) return y
      return size
    }
    const [l, c1, c2, r, gap] = size === 32 ? [9, 15, 16, 22, 3] : [4, 7, 8, 11, 2]
    const crown = Math.min(top(c1), top(c2))
    expect(top(l) - crown).toBeGreaterThanOrEqual(gap)
    expect(top(r) - crown).toBeGreaterThanOrEqual(gap)
  }
})
