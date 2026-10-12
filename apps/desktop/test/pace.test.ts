import { expect, it } from 'vitest'
import { timeLeft } from '../src/renderer/src/lib/pace.js'

it('estimates the time left from the pace since the first count, once a few are done', () => {
  expect(timeLeft(1, 69, { at: 0, from: 0 }, 60_000)).toBe('')
  expect(timeLeft(41, 69, null, 60_000)).toBe('')
  expect(timeLeft(10, 70, { at: 0, from: 0 }, 10 * 60_000)).toBe(' · about 60 min left')
  expect(timeLeft(25, 69, { at: 0, from: 20 }, 5 * 60_000)).toBe(' · about 44 min left')
  expect(timeLeft(68, 69, { at: 0, from: 0 }, 68 * 10_000)).toBe(' · under a minute left')
  expect(timeLeft(69, 69, { at: 0, from: 0 }, 1)).toBe('')
})
