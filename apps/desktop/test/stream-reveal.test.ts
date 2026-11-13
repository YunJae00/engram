import { expect, it } from 'vitest'
import { REVEAL_STEP_MS, nextReveal } from '../src/renderer/src/lib/streamReveal.js'

it('a finished reply shows its tail within 100ms', () => {
  let at = 0
  let elapsed = 0
  while (at < 600) {
    at = nextReveal(at, 600, true)
    elapsed += REVEAL_STEP_MS
  }
  expect(elapsed).toBeLessThanOrEqual(100)
})

it('a streaming reply still reveals in small steps', () => {
  let at = 0
  while (at < 600) {
    const next = nextReveal(at, 600, false)
    expect(next).toBeGreaterThan(at)
    expect(next - at).toBeLessThanOrEqual(Math.max(2, (600 - at) / 2))
    at = next
  }
})
