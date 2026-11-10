import { describe, expect, it } from 'vitest'
import { DIVIDER_GAP_MS, dividerBefore, dividerLabel } from '../src/renderer/src/lib/timeDivider'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'

const iso = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0) => new Date(y, mo, d, h, mi, s, ms).toISOString()
const A = iso(2026, 0, 7, 10, 0)

describe('dividerBefore', () => {
  it('never puts a divider above the first message', () => {
    expect(DIVIDER_GAP_MS).toBe(900000)
    expect(dividerBefore([])).toEqual([])
    expect(dividerBefore([{ at: A }])).toEqual([false])
  })

  it('needs a gap of at least fifteen minutes going forward', () => {
    expect(dividerBefore([{ at: A }, { at: iso(2026, 0, 7, 10, 15) }])).toEqual([false, true])
    expect(dividerBefore([{ at: A }, { at: iso(2026, 0, 7, 10, 14, 59, 999) }])).toEqual([false, false])
    expect(dividerBefore([{ at: A }, { at: iso(2026, 0, 7, 9, 0) }])).toEqual([false, false])
  })

  it('skips messages without a valid time and compares with the last valid one', () => {
    const later = iso(2026, 0, 7, 10, 20)
    expect(dividerBefore([{ at: A }, {}, { at: 42 as unknown as string }, { at: 'nope' }, { at: later }])).toEqual([false, false, false, false, true])
    expect(dividerBefore([{}, { at: A }, { at: later }])).toEqual([false, false, true])
  })

  it('marks the one gap in the visual seed', () => {
    const seed = ['2026-01-06T09:00:00Z', '2026-01-06T09:00:06Z', '2026-01-07T10:30:00Z', '2026-01-07T10:30:04Z'].map(at => ({ at }))
    expect(dividerBefore(seed)).toEqual([false, false, true, false])
  })
})

describe('dividerLabel', () => {
  const d = new Date(2026, 0, 7, 17, 32)
  const at = d.toISOString()
  const fmt = (locale: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, o).format(d)

  it('says today with the time on the same day', () => {
    expect(dividerLabel(at, 'ko', new Date(2026, 0, 7, 20, 0))).toBe('오늘 오후 5:32')
    expect(dividerLabel(at, 'en', new Date(2026, 0, 7, 20, 0))).toBe('Today ' + fmt('en-US', { hour: 'numeric', minute: '2-digit' }))
  })

  it('gives month and day on another day of the same year', () => {
    const o = { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const
    const now = new Date(2026, 0, 9, 9, 0)
    expect(dividerLabel(at, 'en', now)).toBe(fmt('en-US', o))
    expect(dividerLabel(at, 'ko', now)).toBe(fmt('ko-KR', o))
    expect(dividerLabel(at, 'en', now)).not.toMatch(/2026/)
  })

  it('adds the year in another year', () => {
    const label = dividerLabel(at, 'en', new Date(2027, 0, 7, 17, 32))
    expect(label).toBe(fmt('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
    expect(label).toMatch(/2026/)
  })
})

describe('loaded threads keep their times', () => {
  const BOT = 'bot-abc-1'
  it('keeps at on a loaded turn and adds none where there was none', () => {
    const store = createCometThreads(BOT)
    store.load(BOT, [{ role: 'user', text: 'a', at: A }, { role: 'assistant', text: 'b' }])
    const [first, second] = store.thread(BOT).messages
    expect(first!.at).toBe(A)
    expect(Object.hasOwn(second!, 'at')).toBe(false)
  })

  it('marks the seed gap over loaded messages', () => {
    const store = createCometThreads(BOT)
    const times = ['2026-01-06T09:00:00Z', '2026-01-06T09:00:06Z', '2026-01-07T10:30:00Z', '2026-01-07T10:30:04Z']
    store.load(BOT, times.map((at, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text: `t${i}`, at })))
    expect(dividerBefore(store.thread(BOT).messages)).toEqual([false, false, true, false])
  })
})
