import { describe, expect, it } from 'vitest'
import { daysOpen } from '../src/loops.js'
import type { Note } from '../src/schema.js'

const NOW = new Date('2026-07-27T09:00:00Z')

function note(created: string): Note {
  return {
    front: {
      id: 'n-1',
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      open_loop: true,
      created,
      updated: created,
    },
    body: '# t',
  }
}

describe('how long a loop has been open', () => {
  it('counts whole UTC days, like every other deadline in the vault', () => {
    expect(daysOpen(note('2026-07-13T23:00:00Z'), NOW)).toBe(14)
  })

  it('reads 0 on the day it was written, whatever the hour', () => {
    expect(daysOpen(note('2026-07-27T23:59:00Z'), NOW)).toBe(0)
    expect(daysOpen(note('2026-07-27T00:00:00Z'), NOW)).toBe(0)
  })

  it('never goes negative', () => {
    expect(daysOpen(note('2026-08-01T00:00:00Z'), NOW)).toBe(0)
  })

  it('survives a frontmatter date it cannot parse', () => {
    expect(daysOpen(note('not a date'), NOW)).toBe(0)
  })
})
