import { describe, expect, it } from 'vitest'
import { fadingMemories } from '../src/activation.js'
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

describe('fadingMemories', () => {
  const old = (id: string, extra: Partial<NoteFrontmatter> = {}) => note(id, 120, extra)

  it('surfaces a once-used long-quiet memory, skips the never-used and the vivid', () => {
    // Practice makes memories durable (ACT-R): a note recalled twice fades
    // only after a LONG silence — that is the physiology, not a bug.
    const usedDim = note('a-used', 365, {
      recall_count: 2,
      last_recalled: new Date(NOW.getTime() - 300 * 86_400_000).toISOString(),
    })
    const neverUsed = old('b-never')
    const vivid = note('c-vivid', 365, {
      recall_count: 4,
      last_recalled: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
    })
    const picked = fadingMemories([usedDim, neverUsed, vivid], NOW)
    expect(picked.map((n) => n.front.id)).toEqual(['a-used'])
  })

  it('salience and links are storage too, and the cap holds', () => {
    const salient = old('a-salient', { salience: 'high' })
    const linked = old('b-linked', { derived_from: ['x', 'y'] })
    const plain = old('c-plain')
    const picked = fadingMemories([salient, linked, plain], NOW, 1)
    expect(picked).toHaveLength(1)
    expect(picked[0]!.front.id).toBe('a-salient')
  })
})
