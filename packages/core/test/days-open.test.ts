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

// Seven undated loops in a column each printed "no deadline" under a heading
// that already said No deadline. Age is what that cell should have been saying.
describe('how long a loop has been open', () => {
  it('counts whole UTC days, like every other deadline in the vault', () => {
    expect(daysOpen(note('2026-07-13T23:00:00Z'), NOW)).toBe(14)
  })

  it('reads 0 on the day it was written, whatever the hour', () => {
    expect(daysOpen(note('2026-07-27T23:59:00Z'), NOW)).toBe(0)
    expect(daysOpen(note('2026-07-27T00:00:00Z'), NOW)).toBe(0)
  })

  // A note dated in the future (clock skew, a hand-edited file) must not render
  // as "open -3d".
  it('never goes negative', () => {
    expect(daysOpen(note('2026-08-01T00:00:00Z'), NOW)).toBe(0)
  })

  it('survives a frontmatter date it cannot parse', () => {
    expect(daysOpen(note('not a date'), NOW)).toBe(0)
  })
})
