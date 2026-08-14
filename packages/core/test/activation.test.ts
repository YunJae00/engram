import { describe, expect, it } from 'vitest'
import { spreadActivation, triggeredNotes } from '../src/activation.js'
import type { Note } from '../src/schema.js'

// The brain-mimicking retrieval trio: activation spreads over links, Hebbian
// synapses carry it further, salience makes memories come to mind first, and
// trigger keywords fire prospective memories.

const NOW = new Date('2026-07-22T09:00:00Z')

function note(id: string, over: Partial<Note['front']> = {}): Note {
  return {
    front: {
      id,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      created: '2026-07-01T00:00:00Z',
      updated: '2026-07-01T00:00:00Z',
      ...over,
    },
    body: `# ${id}\n\ncontent of ${id}`,
  }
}

describe('spreadActivation', () => {
  it('reaches 2 hops along structural links, nearer notes scoring higher', () => {
    // a(seed) — b — c — d : d is 3 hops out, beyond the default reach.
    const corpus = [
      note('a'),
      note('b', { derived_from: ['a'] }),
      note('c', { derived_from: ['b'] }),
      note('d', { derived_from: ['c'] }),
      note('island'),
    ]
    const hits = spreadActivation(new Map([['a', 10]]), corpus, NOW)
    const ids = hits.map((h) => h.id)
    expect(ids).toContain('b')
    expect(ids).toContain('c')
    expect(ids).not.toContain('d')
    expect(ids).not.toContain('island')
    expect(ids).not.toContain('a') // seeds never re-surface
    expect(hits.find((h) => h.id === 'b')!.score).toBeGreaterThan(hits.find((h) => h.id === 'c')!.score)
    // via names the seed the activation flowed from
    expect(hits.find((h) => h.id === 'c')!.via).toBe('a')
  })

  it('Hebbian recall_links thicken an edge — the co-recalled memory overtakes', () => {
    const corpus = [
      note('a'),
      note('plain', { derived_from: ['a'] }),
      note('wired', {
        derived_from: ['a'],
        recall_links: { a: { w: 4, at: NOW.toISOString() } },
      }),
    ]
    const hits = spreadActivation(new Map([['a', 10]]), corpus, NOW)
    expect(hits[0]!.id).toBe('wired')
    // …and a recall_links-only synapse works with NO structural link at all
    const hebbOnly = [note('a'), note('assoc', { recall_links: { a: { w: 5, at: NOW.toISOString() } } })]
    expect(spreadActivation(new Map([['a', 10]]), hebbOnly, NOW).map((h) => h.id)).toContain('assoc')
  })

  it('salience-high memories come to mind ahead of equal neighbours', () => {
    const corpus = [
      note('a'),
      note('quiet', { derived_from: ['a'] }),
      note('loud', { derived_from: ['a'], salience: 'high' }),
    ]
    const hits = spreadActivation(new Map([['a', 10]]), corpus, NOW)
    expect(hits[0]!.id).toBe('loud')
  })

  it('old co-recall weights decay — a stale synapse loses to a fresh one', () => {
    const corpus = [
      note('a'),
      note('fresh', { recall_links: { a: { w: 2, at: '2026-07-21T00:00:00Z' } } }),
      note('stale', { recall_links: { a: { w: 2, at: '2025-07-21T00:00:00Z' } } }),
    ]
    const hits = spreadActivation(new Map([['a', 10]]), corpus, NOW)
    const fresh = hits.find((h) => h.id === 'fresh')!
    const stale = hits.find((h) => h.id === 'stale')
    if (stale) expect(fresh.score).toBeGreaterThan(stale.score)
    else expect(fresh).toBeDefined() // year-old synapse may fade out entirely
  })
})

describe('triggeredNotes (prospective memory)', () => {
  it('fires when the question mentions a trigger keyword, case-insensitively', () => {
    const corpus = [
      note('deploy-reminder', { triggers: ['배포'] }),
      note('okta-reminder', { triggers: ['Okta', 'SSO'] }),
      note('no-trigger'),
    ]
    expect(triggeredNotes('내일 배포 일정 어떻게 되지?', corpus).map((n) => n.front.id)).toEqual(['deploy-reminder'])
    expect(triggeredNotes('sso 설정 바꿔야 하나', corpus).map((n) => n.front.id)).toEqual(['okta-reminder'])
    expect(triggeredNotes('점심 뭐 먹지', corpus)).toEqual([])
  })
})
