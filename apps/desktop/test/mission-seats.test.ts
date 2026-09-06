import { describe, expect, it } from 'vitest'
import { fillSeats, readSeats, replaceSeat } from '../src/renderer/src/lib/missionSeats.js'

describe('persistent monitor seats', () => {
  it('keeps completed work in its original seat', () => {
    const seats = fillSeats(readSeats(null), ['a', 'b'], ['a', 'b'])
    expect(fillSeats(seats, ['a', 'b'], [])).toBe(seats)
  })
  it('fills only vacancies and never evicts a finished chat', () => {
    expect(fillSeats(['a', null, 'b', null], ['a', 'b', 'c'], ['c'])).toEqual(['a', 'c', 'b', null])
  })
  it('replaces the requested seat and swaps an already seated chat', () => {
    expect(replaceSeat(['a', 'b', 'c', null], 2, 'd')).toEqual(['a', 'b', 'd', null])
    expect(replaceSeat(['a', 'b', 'c', null], 2, 'a')).toEqual(['c', 'b', 'a', null])
  })
  it('restores gaps and rejects duplicate or invalid saved IDs', () => {
    expect(readSeats('["a",null,"b","a","c"]')).toEqual(['a', null, 'b', null])
    expect(readSeats('bad')).toEqual([null, null, null, null])
  })
  it('removes only deleted chats, leaving other indices untouched', () => {
    expect(fillSeats(['a', 'b', 'c', null], ['a', 'c'], [])).toEqual(['a', null, 'c', null])
  })
})
