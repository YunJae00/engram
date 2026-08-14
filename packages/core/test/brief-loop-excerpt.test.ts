import { describe, expect, it } from 'vitest'
import { J8_INSTRUCTION, openLoopsForBrief } from '../src/jobs/librarian.js'
import type { Note } from '../src/schema.js'

const NOW = new Date('2026-07-27T00:00:00Z')

function loop(id: string, body: string): Note {
  return {
    front: {
      id,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      open_loop: true,
      created: '2026-07-20T00:00:00.000Z',
      updated: '2026-07-20T00:00:00.000Z',
    },
    body,
  }
}

describe('what the brief gets to read about an open loop', () => {
  it('carries the note body, not just its title', () => {
    const notes = [
      loop('n-port', '# hcompany 포팅 — 남은 것\n\n- **SATURN-162**: thinking 파라미터 게이트\n- **SATURN-124**: 관리자 hard delete\n'),
    ]
    const { loops } = openLoopsForBrief(notes, NOW)
    expect(loops).toHaveLength(1)
    // the identifiers a useful next step is made of
    expect(loops[0]!.excerpt).toContain('SATURN-162')
    expect(loops[0]!.excerpt).toContain('SATURN-124')
    // the title line itself is dropped — it already travels as `title`
    expect(loops[0]!.excerpt).not.toContain('# hcompany')
  })

  it('keeps the top of a prioritised backlog when the note is long', () => {
    const body = `# 백로그\n\n1. 첫 번째 항목 — 제일 급함\n${'x'.repeat(2000)}\n99. 마지막 항목`
    const { loops } = openLoopsForBrief([loop('n-long', body)], NOW)
    expect(loops[0]!.excerpt).toContain('첫 번째 항목')
    // bounded, so a backlog cannot swallow the prompt
    expect(loops[0]!.excerpt.length).toBeLessThanOrEqual(420)
  })

  it('drops blank lines so the budget buys substance', () => {
    const { loops } = openLoopsForBrief([loop('n-gaps', '# T\n\n\n\n첫 줄\n\n\n\n둘째 줄')], NOW)
    expect(loops[0]!.excerpt).toBe('첫 줄\n둘째 줄')
  })

  it('reads twelve at most — the full list lives in the Today sheet', () => {
    const many = Array.from({ length: 20 }, (_, i) => loop(`n-${i}`, `# 항목 ${i}\n\n내용 ${i}`))
    expect(openLoopsForBrief(many, NOW).loops).toHaveLength(12)
  })

  it('feeds every loop through when the vault has fewer than the cap', () => {
    const seven = Array.from({ length: 7 }, (_, i) => loop(`n-${i}`, `# 항목 ${i}\n\n내용 ${i}`))
    expect(openLoopsForBrief(seven, NOW).loops).toHaveLength(7)
  })
})

// The instruction is the other half: content is useless if the engine is still
// asked for a status line.
describe('J8 asks for the next step, not a restatement', () => {
  it('tells the engine to draw the line from the excerpt', () => {
    expect(J8_INSTRUCTION).toContain('excerpt')
    expect(J8_INSTRUCTION).toContain('the next single step')
  })

  it('bans the phrases a title alone can produce', () => {
    expect(J8_INSTRUCTION).toContain('Restating the title is not an answer')
    for (const banned of ['still incomplete', 'needs review']) {
      expect(J8_INSTRUCTION).toContain(banned)
    }
  })

  // Specificity invites invention: an engine told to name a ticket will happily
  // name one that does not exist.
  it('forbids inventing what the note does not say', () => {
    expect(J8_INSTRUCTION).toContain('do not invent one')
    expect(J8_INSTRUCTION).toContain('only be repeated from the excerpt')
  })

  it('asks for an order once there are more than a few', () => {
    expect(J8_INSTRUCTION).toContain('saying where to start')
  })
})
