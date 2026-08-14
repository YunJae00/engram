import { describe, expect, it } from 'vitest'
import { activationRerank } from '../src/activation.js'
import type { Note, NoteFrontmatter } from '../src/schema.js'

const NOW = new Date('2026-08-13T12:00:00.000Z')

function note(id: string, daysAgo: number, extra: Partial<NoteFrontmatter> = {}): Note {
  const created = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()
  return {
    front: {
      id,
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

describe('activationRerank', () => {
  it('re-orders relevance near-ties by memory luminance', () => {
    const dim = note('a-dim', 90)
    const vivid = note('b-vivid', 90, {
      recall_count: 6,
      last_recalled: new Date(NOW.getTime() - 86_400_000).toISOString(),
    })
    const byId = new Map([dim, vivid].map((n) => [n.front.id, n]))
    const ranked = activationRerank(
      [
        { id: 'a-dim', score: 1.01 },
        { id: 'b-vivid', score: 1.0 },
      ],
      (id) => byId.get(id),
      NOW,
    )
    expect(ranked.map((h) => h.id)).toEqual(['b-vivid', 'a-dim'])
  })

  it('a strong relevance lead survives against a vivid memory', () => {
    const dim = note('a-dim', 90)
    const vivid = note('b-vivid', 0.01)
    const byId = new Map([dim, vivid].map((n) => [n.front.id, n]))
    const ranked = activationRerank(
      [
        { id: 'a-dim', score: 10 },
        { id: 'b-vivid', score: 2 },
      ],
      (id) => byId.get(id),
      NOW,
    )
    expect(ranked.map((h) => h.id)).toEqual(['a-dim', 'b-vivid'])
  })
})
