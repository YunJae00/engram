import { describe, expect, it } from 'vitest'
import { composeWorklog, foldSample, sanitizeTitle, type ActivitySpan, type OpenSpan } from '../src/main/activity-watch.js'

// The desk journal's folding rule: same app+title extends, anything else
// closes — and a span too short to mean anything is never flushed.

const T = 1_754_900_000_000
const span = (over: Partial<OpenSpan> = {}): OpenSpan => ({
  app: 'OUTLOOK',
  title: 'RE: 고객 안내 — 메시지',
  startedAt: T,
  lastSeenAt: T,
  ...over,
})

describe('foldSample', () => {
  it('the same window extends the open span', () => {
    const { next, closed } = foldSample(span(), { app: 'OUTLOOK', title: 'RE: 고객 안내 — 메시지' }, T + 15_000)
    expect(closed).toBeNull()
    expect(next?.lastSeenAt).toBe(T + 15_000)
    expect(next?.startedAt).toBe(T)
  })

  it('a window switch closes a long-enough span and opens the new one', () => {
    const held = span({ lastSeenAt: T + 120_000 })
    const { next, closed } = foldSample(held, { app: 'chrome', title: 'SATURN-307' }, T + 135_000)
    expect(closed?.app).toBe('OUTLOOK')
    expect(next?.app).toBe('chrome')
    expect(next?.startedAt).toBe(T + 135_000)
  })

  it('a blip shorter than a minute is never flushed', () => {
    const blip = span({ lastSeenAt: T + 20_000 })
    const { closed } = foldSample(blip, { app: 'chrome', title: 'x' }, T + 35_000)
    expect(closed).toBeNull()
  })
})

describe('composeWorklog', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 5, h, m)).toISOString()
  const spansOf = (...items: [string, string, number, number][]): ActivitySpan[] =>
    items.map(([app, title, startH, endH]) => ({ app, title, start: at(startH), end: at(endH) }))

  it('writes the day as one note: total, per-app hours, held titles', () => {
    const log = composeWorklog(
      '2026-08-05',
      spansOf(['OUTLOOK', 'RE: 고객 안내', 9, 10], ['Code', 'session-watch.ts — strata', 10, 13], ['chrome', '(private)', 13, 14]),
    )
    expect(log).toContain('# Work log 2026-08-05')
    expect(log).toContain('Desk time 5.0h across 3 apps')
    expect(log).toContain('- Code 3.0h — session-watch.ts — strata')
    expect(log).not.toContain('(private)')
  })

  it('a day under half an hour is not a work day', () => {
    expect(composeWorklog('2026-08-05', spansOf(['chrome', 'x', 9, 9]))).toBeNull()
  })
})

describe('sanitizeTitle', () => {
  it('deny-listed titles are recorded as (private), the rest pass truncated', () => {
    expect(sanitizeTitle('은행 계좌 로그인')).toBe('(private)')
    expect(sanitizeTitle('password reset — Chrome')).toBe('(private)')
    expect(sanitizeTitle('SATURN-307 딥리서치')).toBe('SATURN-307 딥리서치')
  })
})
