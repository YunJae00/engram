import { describe, expect, it } from 'vitest'
import { firstSightOffset } from '../src/main/session-watch.js'

const NOW = 1_754_900_000_000
const DAY = 86_400_000

describe('firstSightOffset', () => {
  it('fresh install adopts the end of everything — history is not our business', () => {
    expect(firstSightOffset(false, NOW - 1000, 5_000, NOW)).toBe(5_000)
    expect(firstSightOffset(false, NOW - 30 * DAY, 5_000, NOW)).toBe(5_000)
  })

  it('after a prior run, a file born in the gap is read from byte zero', () => {
    expect(firstSightOffset(true, NOW - 3 * DAY, 5_000, NOW)).toBe(0)
    expect(firstSightOffset(true, NOW - 1000, 123, NOW)).toBe(0)
  })

  it('even with a prior run, a transcript older than the gap window stays history', () => {
    expect(firstSightOffset(true, NOW - 15 * DAY, 5_000, NOW)).toBe(5_000)
  })
})
