import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ width: 16, height: 16, empty: false, oversized: false, resizes: [] as { width: number; height: number }[] }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => {
  const image = (width: number, height: number): object => ({
    isEmpty: () => state.empty,
    getSize: () => ({ width, height }),
    resize: (size: { width: number; height: number }) => {
      state.resizes.push({ width: size.width, height: size.height })
      return image(size.width, size.height)
    },
    toJPEG: () => Buffer.alloc(state.oversized ? width * height : 32),
  })
  return image(state.width, state.height)
} } }))
import { fitImage } from '../src/main/image-fit.js'

beforeEach(() => Object.assign(state, { width: 16, height: 16, empty: false, oversized: false, resizes: [] }))
const input = { data: Buffer.from('image').toString('base64'), mimeType: 'image/png' }

it('keeps a small readable image unchanged and rejects undecodable data', () => {
  expect(fitImage(input)).toEqual(input)
  state.empty = true
  expect(() => fitImage(input)).toThrow('could not be read')
})

it('fits both dimensions without rounding a narrow image to zero', () => {
  state.width = 100_000
  state.height = 1
  expect(fitImage(input).mimeType).toBe('image/jpeg')
  expect(state.resizes).toEqual([{ width: 4096, height: 1 }])
})

it('continues reducing dimensions when JPEG quality alone cannot fit four megabytes', () => {
  state.width = 8192
  state.height = 8192
  state.oversized = true
  const result = fitImage(input)
  expect(Buffer.from(result.data, 'base64').length).toBeLessThanOrEqual(4_000_000)
  expect(state.resizes[0]).toEqual({ width: 4096, height: 4096 })
  expect(state.resizes.at(-1)).toEqual({ width: 1024, height: 1024 })
})
