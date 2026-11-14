import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { EXIT_MS, FALLBACK_RATIO, heldLayers, lingerStep, recallPaint, rememberPaint, shownRatio } from '../src/renderer/src/lib/previewMotion.js'

const PICTURE = 'data:image/png;base64,x'
const css = readFileSync(new URL('../src/renderer/src/components/preview-card.css', import.meta.url), 'utf8')
const rule = (selector: string) => css.split('\n').find(line => line.startsWith(`${selector} {`)) ?? ''

it('keeps the last size and picture of a frame across a remount', () => {
  expect(rememberPaint('remount', 'a', 600, 800, PICTURE)).toBe(true)
  expect(recallPaint('remount', 'a')).toEqual({ size: { id: 'a', width: 600, height: 800 }, image: PICTURE })
  expect(rememberPaint('remount', 'a', 600, 800, PICTURE)).toBe(false)
  expect(rememberPaint('remount', 'a', 800, 600)).toBe(true)
  expect(rememberPaint('remount', 'a', 0, 0, 'https://example.com/a.png')).toBe(false)
  expect(recallPaint('remount', 'a')).toEqual({ size: { id: 'a', width: 800, height: 600 }, image: PICTURE })
})

it('starts a known frame at its remembered ratio and an unknown one at the ratio already shown', () => {
  rememberPaint('ratio', 'a', 600, 800)
  expect(shownRatio(recallPaint('ratio', 'a')?.size, 'a', FALLBACK_RATIO)).toBeCloseTo(0.75)
  expect(shownRatio(recallPaint('ratio', 'b')?.size, 'b', 0.75)).toBe(0.75)
  expect(recallPaint('other-lane', 'a')).toBeUndefined()
})

it('forgets the oldest frames past the limit', () => {
  for (let index = 0; index < 60; index++) rememberPaint('cap', `id${index}`, 4, 3)
  expect(recallPaint('cap', 'id0')).toBeUndefined()
  expect(recallPaint('cap', 'id11')).toBeUndefined()
  expect(recallPaint('cap', 'id12')).toBeDefined()
  expect(recallPaint('cap', 'id59')).toBeDefined()
})

it('animates a ratio change: the stage height follows width/ratio and transitions instead of jumping', () => {
  // Animating a registered custom property every frame crashed the renderer; the stage height is transitioned instead.
  expect(css).not.toMatch(/@property --pc-ratio/)
  expect(rule('.preview-card')).not.toContain('transition: --pc-ratio')
  expect(rule('.preview-card-stage')).toContain('height: calc(100cqi / var(--pc-ratio')
  expect(rule('.preview-card-stage')).toContain('transition: height')
  expect(rule('.preview-card-stage')).not.toContain('aspect-ratio')
  expect(rule('.preview-card-stage')).not.toContain('animation')
  expect(rule('.preview-card')).toContain('container: preview / inline-size')
  expect(rule('.preview-deck .preview-card')).toContain('* var(--pc-ratio')
  expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^\n]*\.preview-card-stage, \.preview-card-stage canvas \{ transition: none; \}/)
})

it('holds the last picture under a front that has not painted, and none for a frame with no picture', () => {
  expect(heldLayers('ready', 'img', undefined, 'old')).toEqual([{ key: 'previous', image: 'old' }])
  expect(heldLayers('ready', 'img', 'own', 'old')).toEqual([{ key: 'previous', image: 'old' }])
  expect(heldLayers('waiting', 'canvas', 'own', 'old')).toEqual([{ key: 'previous', image: 'old' }, { key: 'own', image: 'own' }])
  expect(heldLayers('ready', 'canvas', 'own', 'own')).toEqual([{ key: 'own', image: 'own' }])
  expect(heldLayers('waiting', 'none', 'own', 'old')).toEqual([{ key: 'own', image: 'own' }])
  for (const phase of ['unavailable', 'empty', 'activity', 'no-snapshot']) expect(heldLayers(phase, 'canvas', 'own', 'old')).toEqual([])
})

it('schedules the deck exit before it unmounts', () => {
  const deck = { key: 'deck' }
  const gone = lingerStep([], [deck], [], 1000, EXIT_MS)
  expect(gone).toEqual([{ item: deck, until: 1160 }])
  expect(lingerStep(gone, [deck], [], 1100, EXIT_MS)).toBe(gone)
  expect(lingerStep(gone, [], [], 1160, EXIT_MS)).toEqual([])
  expect(lingerStep(gone, [], [deck], 1050, EXIT_MS)).toEqual([])
  expect(lingerStep([], [deck], [], 1000, 0)).toEqual([])
  const idle: never[] = []
  expect(lingerStep(idle, [deck], [deck], 1000, EXIT_MS)).toBe(idle)
})
