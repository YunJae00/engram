import { describe, expect, it } from 'vitest'
import { buildBrain } from '../src/renderer/src/lib/topics.js'
import type { NoteDto } from '../src/shared/types.js'

function dto(id: string, title: string, extra: Partial<NoteDto> = {}): NoteDto {
  return {
    id,
    title,
    status: 'current',
    type: 'note',
    decay: 'slow',
    badge: '🟢',
    timeline: 'inferred',
    created: '2026-08-13T00:00:00.000Z',
    updated: '2026-08-13T00:00:00.000Z',
    supersedes: [],
    derived_from: [],
    activation: 0.9,
    excerpt: '',
    ...extra,
  }
}

describe('buildBrain with the similarity fabric', () => {
  const pool = [dto('a', 'helm 배포 결정'), dto('b', 'helm values 정리'), dto('c', '김장 레시피')]

  it('meaning-level edges group unlinked notes into a topic', () => {
    const brain = buildBrain(pool, {}, [{ a: 'a', b: 'b', w: 0.8 }])
    expect(brain.topics).toHaveLength(1)
    expect(brain.topics[0]!.members.map((m) => m.id).sort()).toEqual(['a', 'b'])
    expect(brain.unconnected.map((n) => n.id)).toEqual(['c'])
  })

  it('without fabric the same notes stay loose neurons (semantic-off degrade)', () => {
    const brain = buildBrain(pool, {})
    expect(brain.topics).toHaveLength(0)
    expect(brain.unconnected).toHaveLength(3)
  })
})
