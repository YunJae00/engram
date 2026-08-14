import { describe, expect, it } from 'vitest'
import { noteActivation } from '../src/activation.js'
import type { Note, NoteFrontmatter } from '../src/schema.js'

const NOW = new Date('2026-08-13T12:00:00.000Z')

function noteAt(daysAgo: number, extra: Partial<NoteFrontmatter> = {}): Note {
  const created = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()
  return {
    front: {
      id: `n${daysAgo}`,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      created,
      updated: created,
      ...extra,
    } as NoteFrontmatter,
    body: 'body',
  }
}

describe('noteActivation — the memory luminance curve', () => {
  it('burns bright at birth and cools monotonically without use', () => {
    const fresh = noteActivation(noteAt(0.01), NOW)
    const week = noteActivation(noteAt(7), NOW)
    const month = noteActivation(noteAt(30), NOW)
    const quarter = noteActivation(noteAt(90), NOW)
    expect(fresh).toBeGreaterThan(0.9)
    expect(week).toBeLessThan(fresh)
    expect(month).toBeLessThan(week)
    expect(quarter).toBeLessThan(month)
    expect(quarter).toBeGreaterThan(0.1) // dim, never zero — stale is not gone
  })

  it('frequency keeps an old memory vivid (ACT-R practice term)', () => {
    const idle = noteAt(30)
    const rehearsed = noteAt(30, {
      recall_count: 5,
      last_recalled: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
    })
    expect(noteActivation(rehearsed, NOW)).toBeGreaterThan(noteActivation(idle, NOW) + 0.3)
  })

  it('a single recent recall re-lights a month-old memory', () => {
    const idle = noteAt(30)
    const touched = noteAt(30, {
      recall_count: 1,
      last_recalled: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
    })
    expect(noteActivation(touched, NOW)).toBeGreaterThan(noteActivation(idle, NOW))
  })

  it('re-exposure warmth lifts a memory, but less than a real recall', () => {
    const idle = noteAt(30)
    const warmed = noteAt(30, { warmth: { w: 1, at: new Date(NOW.getTime() - 86_400_000).toISOString() } })
    const recalled = noteAt(30, {
      recall_count: 1,
      last_recalled: new Date(NOW.getTime() - 86_400_000).toISOString(),
    })
    const idleScore = noteActivation(idle, NOW)
    const warmScore = noteActivation(warmed, NOW)
    const recallScore = noteActivation(recalled, NOW)
    expect(warmScore).toBeGreaterThan(idleScore)
    expect(recallScore).toBeGreaterThan(warmScore)
  })

  it('decay classes bend the curve: ephemeral dims in days, evergreen holds for months', () => {
    const ephemeralWeek = noteActivation(noteAt(7, { decay: 'ephemeral' }), NOW)
    const evergreenQuarter = noteActivation(noteAt(90, { decay: 'evergreen' }), NOW)
    expect(ephemeralWeek).toBeLessThan(0.3)
    expect(evergreenQuarter).toBeGreaterThan(0.55)
  })
})
