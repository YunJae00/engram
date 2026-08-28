import { describe, expect, it } from 'vitest'
import { askKey, repeatedAsk, sameAsk } from '../src/repeat.js'

const at = (y: number, m: number, d: number, h: number, min = 0): string => new Date(y, m - 1, d, h, min).toISOString()

describe('askKey / sameAsk', () => {
  it('strips the asking and punctuation', () => {
    expect(askKey('포털 공지 확인해줘!')).toBe(askKey('포털 공지 좀 확인해 줘'))
    expect(askKey('check the deploy notice please')).toBe('deploy notice')
  })
  it('sees the same ask through glued endings and stems, not a different subject', () => {
    expect(sameAsk('deploy notice', 'deployment notices')).toBe(true)
    expect(sameAsk('주차 정책 확인해줘', '배포 정책 확인해줘')).toBe(false)
    expect(sameAsk('', '포털')).toBe(false)
  })
})

describe('repeatedAsk', () => {
  const now = new Date(2026, 7, 27, 9, 10)
  it('needs two earlier days, and reads the schedule off the times', () => {
    const past = [
      { text: '포털 공지 확인해줘', at: at(2026, 8, 25, 8, 50) },
      { text: '다른 일', at: at(2026, 8, 25, 14, 0) },
      { text: '포털 공지 좀 확인해 줘', at: at(2026, 8, 26, 9, 5) },
    ]
    const verdict = repeatedAsk(past, '포털 공지 확인해줘', now)
    expect(verdict?.count).toBe(3)
    expect(verdict?.schedule).toEqual({ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 })
  })
  it('two asks on the same day are one day', () => {
    const past = [
      { text: '포털 공지 확인해줘', at: at(2026, 8, 26, 8, 50) },
      { text: '포털 공지 확인해줘', at: at(2026, 8, 26, 9, 5) },
    ]
    expect(repeatedAsk(past, '포털 공지 확인해줘', now)).toBeNull()
  })
  it('an ask earlier today does not count as another day', () => {
    const past = [
      { text: '포털 공지 확인해줘', at: at(2026, 8, 26, 9, 0) },
      { text: '포털 공지 확인해줘', at: at(2026, 8, 27, 8, 0) },
    ]
    expect(repeatedAsk(past, '포털 공지 확인해줘', now)).toBeNull()
  })
})
