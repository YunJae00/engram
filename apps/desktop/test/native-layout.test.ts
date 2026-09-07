import { describe, expect, it } from 'vitest'
import { normalizeNativeSurfaces } from '../src/main/native-layout.js'

describe('native surface bounds', () => {
  it('preserves the page viewport while cropping a partially visible native surface', () => {
    expect(normalizeNativeSurfaces([{ lane: 'a', x: -10, y: -30, width: 200, height: 300, clip: { x: 10, y: 50, width: 100, height: 100 } }], 100, 200)).toEqual([
      { lane: 'a', x: -10, y: -30, width: 200, height: 300, clip: { x: 10, y: 50, width: 100, height: 100 } },
    ])
    expect(normalizeNativeSurfaces([{ lane: 'a', x: 0, y: 0, width: 100, height: 100, clip: { x: NaN, y: 0, width: 50, height: 50 } }], 100, 100)).toEqual([])
  })
  it('clips rectangles to the renderer without accepting nonfinite dimensions', () => {
    expect(normalizeNativeSurfaces([
      { lane: 'a', x: -10, y: 20, width: 200, height: 300 },
      { lane: 'b', x: 20, y: 20, width: Infinity, height: 50 },
      { lane: 'c', x: 90, y: 190, width: 200, height: 300 },
    ], 100, 200)).toEqual([{ lane: 'a', x: 0, y: 20, width: 100, height: 180 }])
  })

  it('keeps no more than four pages and gives a duplicate lane its last surface', () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 }
    expect(normalizeNativeSurfaces(['a', 'b', 'c', 'd', 'e'].map((lane) => ({ lane, ...rect })), 100, 100).map((item) => item.lane)).toEqual(['b', 'c', 'd', 'e'])
    expect(normalizeNativeSurfaces([{ lane: 'a', ...rect }, { lane: 'a', ...rect, width: 50 }], 100, 100)).toEqual([{ lane: 'a', ...rect, width: 50 }])
  })

  it('rejects malformed, empty, and off-screen requests', () => {
    expect(normalizeNativeSurfaces(null, 100, 100)).toEqual([])
    expect(normalizeNativeSurfaces([null, 1, {}, { lane: '', x: 0, y: 0, width: 50, height: 50 }, { lane: 'a', x: 110, y: 0, width: 50, height: 50 }], 100, 100)).toEqual([])
  })
})
