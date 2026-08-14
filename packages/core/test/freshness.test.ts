import { describe, expect, it } from 'vitest'
import { badgeOf, freshnessOf } from '../src/freshness.js'
import type { Note } from '../src/schema.js'
import { frontmatterSchema } from '../src/schema.js'

const NOW = new Date('2026-07-01T00:00:00Z')

function makeNote(over: Record<string, unknown>): Note {
  return {
    front: frontmatterSchema.parse({
      id: 'n-x-0001',
      created: '2026-06-01T00:00:00Z',
      updated: '2026-06-01T00:00:00Z',
      ...over,
    }),
    body: '# t',
  }
}

describe('freshness calculator (decay × verified_until)', () => {
  it('evergreen is always fresh', () => {
    expect(freshnessOf(makeNote({ decay: 'evergreen' }), NOW)).toBe('fresh')
  })

  it('a valid verification window is fresh', () => {
    const note = makeNote({ decay: 'slow', verified_until: '2026-12-01T00:00:00Z' })
    expect(freshnessOf(note, NOW)).toBe('fresh')
  })

  it('past verified_until is stale', () => {
    const note = makeNote({ decay: 'fast', verified_until: '2026-06-20T00:00:00Z' })
    expect(freshnessOf(note, NOW)).toBe('stale')
  })

  it('imminent expiry (≤20% of window) is aging', () => {
    // fast = 30d window; 5 days remaining ≤ 6d threshold.
    const note = makeNote({ decay: 'fast', verified_until: '2026-07-06T00:00:00Z' })
    expect(freshnessOf(note, NOW)).toBe('aging')
  })

  it('disputed status wins over any clock', () => {
    const note = makeNote({ status: 'disputed', verified_until: '2027-01-01T00:00:00Z' })
    expect(freshnessOf(note, NOW)).toBe('disputed')
  })

  it('missing verified_until runs the clock from created', () => {
    const note = makeNote({ decay: 'fast' })
    expect(freshnessOf(note, NOW)).toBe('stale')
  })

  it('maps freshness to the badge set 🟢🟡🔴⚔️', () => {
    expect(badgeOf(makeNote({ decay: 'evergreen' }), NOW)).toBe('🟢')
    expect(badgeOf(makeNote({ decay: 'fast', verified_until: '2026-07-06T00:00:00Z' }), NOW)).toBe('🟡')
    expect(badgeOf(makeNote({ decay: 'fast', verified_until: '2026-06-20T00:00:00Z' }), NOW)).toBe('🔴')
    expect(badgeOf(makeNote({ status: 'disputed' }), NOW)).toBe('⚔️')
  })
})
