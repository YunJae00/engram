import { describe, expect, it } from 'vitest'
import { gardenCandidates } from '../src/gardener.js'
import type { Note } from '../src/schema.js'

// The gardener shelves only what its three conditions ALL prove abandoned:
// fast-decay by declaration, old, and unrecalled for a season. Everything the
// user might still be leaning on is structurally out of reach.

const NOW = new Date('2026-08-05T09:00:00Z')
const OLD = '2026-04-01T00:00:00.000Z'
let n = 0
function note(title: string, over: Partial<Note['front']> = {}): Note {
  n += 1
  return {
    front: {
      id: `n-${n}`,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      created: OLD,
      updated: OLD,
      ...over,
    },
    body: `# ${title}\n\nbody`,
  }
}

describe('gardenCandidates', () => {
  it('shelves the old, fast-decaying, never-recalled — and only that', () => {
    const shelved = note('옛날 임시 메모', { decay: 'fast' })
    const picked = gardenCandidates(
      [
        shelved,
        note('slow decay는 보존', {}),
        note('최근 회수됨', { decay: 'fast', last_recalled: '2026-07-30T00:00:00.000Z' }),
        note('아직 어린 노트', { decay: 'fast', created: '2026-07-20T00:00:00.000Z' }),
        note('열린 고리는 약속', { decay: 'fast', open_loop: true }),
        note('허브는 구조', { decay: 'fast', type: 'hub' }),
        note('분쟁 중은 질문', { decay: 'fast', status: 'disputed' }),
      ],
      NOW,
    )
    expect(picked.map((p) => p.front.id)).toEqual([shelved.front.id])
  })

  it('a recall older than the season no longer protects', () => {
    const cold = note('식은 회수', { decay: 'ephemeral', last_recalled: '2026-04-20T00:00:00.000Z' })
    expect(gardenCandidates([cold], NOW)).toHaveLength(1)
  })

  it('caps a sweep at 20 — a gardener prunes, it does not clear-cut', () => {
    const notes = Array.from({ length: 30 }, () => note('임시', { decay: 'fast' }))
    expect(gardenCandidates(notes, NOW)).toHaveLength(20)
  })
})
