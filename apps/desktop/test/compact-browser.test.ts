import { describe, expect, it } from 'vitest'
import { compactBrowser } from '../src/renderer/src/lib/useCompactBrowser.js'

describe('browser layout', () => {
  it('keeps a full-width chat until both panes have enough space', () => {
    expect(compactBrowser(680, 730)).toBe(true)
    expect(compactBrowser(959, 800)).toBe(true)
    expect(compactBrowser(1200, 559)).toBe(true)
    expect(compactBrowser(960, 560)).toBe(false)
    expect(compactBrowser(1100, 900)).toBe(false)
  })
})
