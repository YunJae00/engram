import { describe, expect, it } from 'vitest'
import { quickCometBounds } from '../src/main/quick-comet.js'

describe('quick Comet placement', () => {
  it('opens beside the pointer', () => {
    expect(quickCometBounds({ x: 100, y: 200 }, { x: 0, y: 0, width: 1920, height: 1080 })).toEqual({ x: 116, y: 216, width: 400, height: 96 })
  })
  it('stays inside the pointer monitor, including negative coordinates and taskbar space', () => {
    expect(quickCometBounds({ x: -5, y: 1030 }, { x: -1920, y: 0, width: 1920, height: 1040 })).toEqual({ x: -412, y: 932, width: 400, height: 96 })
  })
  it('fits smaller displays and clamps pointers outside the work area', () => {
    expect(quickCometBounds({ x: -100, y: -100 }, { x: 0, y: 0, width: 400, height: 180 })).toEqual({ x: 12, y: 12, width: 376, height: 96 })
  })
})
