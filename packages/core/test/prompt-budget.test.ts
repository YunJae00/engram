import { describe, expect, it } from 'vitest'
import { fitPrompt } from '../src/prompt-budget.js'

// The local model cannot shift a prompt that is one long user turn: an
// oversized one comes back as a library error the user reads as the answer.

const RULES = ['rule one', 'rule two']
const ASK = 'User: what did we decide about the release?'
const big = (n: number, tag: string) => `${tag}:${'x'.repeat(n)}`

describe('fitPrompt', () => {
  it('sends everything to an engine that is not the local model', () => {
    const out = fitPrompt(RULES, [big(50_000, 'bg')], [big(50_000, 'ev')], ASK, 'claude')
    expect(out.length).toBeGreaterThan(100_000)
    expect(out.endsWith(ASK)).toBe(true)
  })

  it('keeps a small prompt whole and ends on the question', () => {
    const out = fitPrompt(RULES, ['the map'], ['note A', 'note B'], ASK, 'local')
    expect(out).toBe(['rule one', 'rule two', 'the map', 'note A', 'note B', ASK].join('\n\n'))
  })

  it('caps a huge prompt well inside the local window', () => {
    const evidence = Array.from({ length: 12 }, (_, i) => big(1_200, `ev${i}`))
    const out = fitPrompt(RULES, [big(4_000, 'map'), big(3_000, 'recent')], evidence, ASK, 'local')
    expect(out.length).toBeLessThan(Math.floor((4096 - 700) * 1.6))
  })

  it('rules and the question always survive, however big the context', () => {
    const out = fitPrompt(RULES, [big(90_000, 'bg')], [big(90_000, 'ev')], ASK, 'local')
    expect(out).toContain('rule one')
    expect(out).toContain('rule two')
    expect(out.endsWith(ASK)).toBe(true)
  })

  it('drops the weakest evidence first — the best match sits nearest the ask', () => {
    // Evidence arrives weakest-first, so the LAST entry is the strongest.
    const evidence = [big(2_000, 'weak'), big(2_000, 'middling'), big(2_000, 'strongest')]
    const out = fitPrompt(RULES, [big(2_000, 'map')], evidence, ASK, 'local')
    expect(out).toContain('strongest')
    expect(out).not.toContain('weak:')
    expect(out.indexOf('strongest')).toBeGreaterThan(out.indexOf('map'))
  })
})
