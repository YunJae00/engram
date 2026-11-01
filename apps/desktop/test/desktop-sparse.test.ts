import { expect, it } from 'vitest'
import type { QuietObservationDto } from '../src/shared/desktop.js'
import { sparseDesktopTree } from '../src/main/desktop-sparse.js'
const observation: QuietObservationDto = {
  window: '1', pid: 1, title: 'Fixture', snapshot: 'a'.repeat(32), controls: [], texts: [], skippedControls: 0, skippedTexts: 0, ms: 1,
  bounds: { x: 0, y: 0, width: 640, height: 480 }, state: { foreground: false, minimized: false, idleMs: 9000 },
}
it('distinguishes sparse content from decoration, dense controls and partial views', () => {
  const controls = ['Close', 'Minimize', 'Full screen'].map((name, i) => ({ id: `c${i}`, name, type: 'Button', can: { set: false, press: true, text: false }, enabled: true, offscreen: false, focused: false, secret: false }))
  expect(sparseDesktopTree({ ...observation, controls })).toBe(true)
  expect(sparseDesktopTree({ ...observation, controls: [...controls, ...Array.from({ length: 6 }, (_, i) => ({ ...controls[0]!, name: `Action ${i}` }))] })).toBe(false)
  expect(sparseDesktopTree({ ...observation, truncated: true })).toBe(false)
  expect(sparseDesktopTree({ ...observation, mode: 'skeleton' })).toBe(false)
  expect(sparseDesktopTree({ ...observation, bounds: { x: 0, y: 0, width: 100, height: 30 } })).toBe(false)
})
