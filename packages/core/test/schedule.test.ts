import { describe, expect, it } from 'vitest'
import { dueNow, guessSchedule, isSchedule } from '../src/schedule.js'

// Local-time dates: the person's mornings are on the local clock.
const at = (y: number, m: number, d: number, h: number, min = 0): Date => new Date(y, m - 1, d, h, min)

describe('guessSchedule', () => {
  it('weekday mornings become weekdays at 9', () => {
    // 2026-08-24 is a Monday.
    expect(guessSchedule([at(2026, 8, 24, 8, 50), at(2026, 8, 26, 9, 5), at(2026, 8, 27, 9, 20)])).toEqual({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
  })
  it('a single weekday stays that weekday, and a weekend lists the days seen', () => {
    expect(guessSchedule([at(2026, 8, 17, 9), at(2026, 8, 24, 9)]).days).toEqual([1])
    expect(guessSchedule([at(2026, 8, 25, 9), at(2026, 8, 29, 9)]).days).toEqual([2, 6])
  })
  it('the hour rounds by the half', () => {
    expect(guessSchedule([at(2026, 8, 24, 9, 40), at(2026, 8, 25, 9, 45), at(2026, 8, 26, 10, 10)]).hour).toBe(10)
  })
  it('recognises a well-formed schedule', () => {
    expect(isSchedule({ days: [1, 2], hour: 9, minute: 0 })).toBe(true)
    expect(isSchedule({ days: [7], hour: 9, minute: 0 })).toBe(false)
    expect(isSchedule({ days: [1], hour: 9, minute: 15 })).toBe(false)
  })
})

describe('dueNow', () => {
  const weekdays = { days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
  it('is due inside the two-hour window on a listed day, once', () => {
    expect(dueNow(weekdays, undefined, at(2026, 8, 25, 9, 10))).toBe(true)
    expect(dueNow(weekdays, undefined, at(2026, 8, 25, 11, 30))).toBe(false)
    expect(dueNow(weekdays, undefined, at(2026, 8, 25, 8, 50))).toBe(false)
    expect(dueNow(weekdays, undefined, at(2026, 8, 29, 9, 10))).toBe(false)
    expect(dueNow(weekdays, at(2026, 8, 25, 9, 2).toISOString(), at(2026, 8, 25, 9, 10))).toBe(false)
    expect(dueNow(weekdays, at(2026, 8, 24, 9, 2).toISOString(), at(2026, 8, 25, 9, 10))).toBe(true)
  })
})
