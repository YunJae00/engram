import { describe, expect, it } from 'vitest'
import { buildJ3 } from '../src/jobs/librarian.js'
import type { Note } from '../src/schema.js'
import type { VaultPaths } from '../src/vault.js'

const NOW = '2026-07-05T00:00:00.000Z'

function makeNote(id: string, body: string): Note {
  return {
    front: {
      id,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      created: NOW,
      updated: NOW,
    },
    body,
  }
}

// The input payload is always the LAST fenced json block buildJobPrompt emits.
function corpusOf(prompt: string): { id: string }[] {
  const blocks = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)]
  const last = blocks[blocks.length - 1]
  if (!last) throw new Error('no json payload in prompt')
  return (JSON.parse(last[1]!) as { corpus: { id: string }[] }).corpus
}

describe('librarian prompt context is retrieval-bounded', () => {
  it('a 200-note corpus yields ≤60 J3 corpus entries and excludes the targets', () => {
    // 10 topics × 20 notes. The corpus INCLUDES the delta (real sweeps pass the
    // full current corpus), so excluding the targets is a meaningful assertion.
    const corpus: Note[] = []
    for (let i = 0; i < 200; i++) {
      corpus.push(makeNote(`n-${String(i).padStart(4, '0')}`, `# 노트 ${i}\n\ntopic${i % 10} 관련 상세 내용 ${i}`))
    }
    // one target per topic (notes 0..9 cover topic0..topic9), drawn from corpus
    const delta = corpus.slice(0, 10)

    const job = buildJ3({} as VaultPaths, '', delta, corpus, new Date(NOW))
    const candidates = corpusOf(job.prompt)

    // union of 10 disjoint-topic queries would exceed the cap; it is bounded
    expect(candidates.length).toBeLessThanOrEqual(60)
    expect(candidates.length).toBeGreaterThan(30)
    const deltaIds = new Set(delta.map((n) => n.front.id))
    for (const c of candidates) expect(deltaIds.has(c.id)).toBe(false)
  })

  it('a small corpus (≤ cap) is unchanged: every non-target note is sent', () => {
    const corpus = Array.from({ length: 12 }, (_, i) => makeNote(`n-${i}`, `# 노트 ${i}\n\n내용 ${i}`))
    const delta = corpus.slice(0, 2)

    const candidates = corpusOf(buildJ3({} as VaultPaths, '', delta, corpus, new Date(NOW)).prompt)

    expect(candidates.map((c) => c.id).sort()).toEqual(corpus.slice(2).map((n) => n.front.id).sort())
  })
})
