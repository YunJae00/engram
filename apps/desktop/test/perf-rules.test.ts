import { expect, it } from 'vitest'
import { passes } from '../e2e/perf/perf-rules'

it('allows one 8ms Event Timing step over a baseline above target, and nothing more', () => {
  expect(passes(48, 32, 40)).toBe(false) // unquantised parts keep the strict bar
  expect(passes(40, 32, 40)).toBe(false)
  expect(passes(48, 32, 40, 8)).toBe(true) // 40 * 1.1 + 8 = 52
  expect(passes(56, 32, 40, 8)).toBe(false)
  expect(passes(32, 32, 24, 8)).toBe(true) // within target, baseline 24 * 1.1 + 8
  expect(passes(40, 32, 24, 8)).toBe(false) // never past the target when the baseline meets it
})
