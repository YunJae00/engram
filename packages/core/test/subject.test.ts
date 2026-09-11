import { describe, expect, it } from 'vitest'
import { mergeBySubject, titleTokens } from '../src/jobs/subject.js'
import { linkComponents } from '../src/jobs/hub.js'
import type { Note } from '../src/schema.js'

type Edge = [string, string]

function adjOf(edges: Edge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  return adj
}

const clique = (ids: string[]): Edge[] => ids.flatMap((a, i) => ids.slice(i + 1).map((b): Edge => [a, b]))

// A community: ids `${prefix}1..n` carrying the given titles.
function community(prefix: string, titles: string[]): { ids: string[]; titles: Map<string, string> } {
  const ids = titles.map((_, i) => `${prefix}${i + 1}`)
  return { ids, titles: new Map(ids.map((id, i) => [id, titles[i]!])) }
}

// Synthetic titles share one dominant topic across two connected communities.
const TOPIC_PRIMARY = community('a', [
  'Workspace draft create',
  'Workspace draft rename',
  'Workspace draft delete',
  'Workspace draft list',
  'Workspace draft select',
  'Workspace draft archive',
  'Storage quota update',
  'Search ranking update',
])
const TOPIC_SECONDARY = community('b', [
  'Workspace filter add',
  'Workspace filter remove',
  'Workspace filter rename',
  'Workspace filter reset',
  'Workspace filter select',
])

// A bare project prefix must not merge otherwise distinct topics.
const PROJECT_LOCALE = community('i', [
  'PROJECT locale choose',
  'PROJECT locale reset',
  'PROJECT locale detect',
  'PROJECT locale display',
  'PROJECT locale fallback',
])
const PROJECT_MESSAGES = community('c', [
  'PROJECT messages create',
  'PROJECT messages list',
  'PROJECT messages search',
  'PROJECT messages archive',
  'PROJECT messages delete',
])
const PROJECT_ACCESS = community('o', [
  'PROJECT access request',
  'PROJECT access review',
  'PROJECT access revoke',
  'PROJECT access expire',
  'PROJECT access audit',
])
const PROJECT_EXPORT = community('p', [
  'PROJECT export start',
  'PROJECT export cancel',
  'PROJECT export status',
  'PROJECT export retry',
  'PROJECT export finish',
])

const ALL = [TOPIC_PRIMARY, TOPIC_SECONDARY, PROJECT_LOCALE, PROJECT_MESSAGES, PROJECT_ACCESS, PROJECT_EXPORT]
const titleOf = (id: string): string => {
  for (const c of ALL) {
    const t = c.titles.get(id)
    if (t !== undefined) return t
  }
  throw new Error(`no title for ${id}`)
}

// Dense internal links and sparse connections between communities.
const EDGES: Edge[] = [
  ...ALL.flatMap((c) => clique(c.ids)),
  ['a1', 'b1'], ['a2', 'b2'], ['a3', 'b1'],
  ['i1', 'c1'], ['c1', 'o1'], ['o1', 'p1'], ['i2', 'p2'],
]
const ADJ = adjOf(EDGES)
const COMMUNITIES = ALL.map((c) => c.ids)

const idsOf = (groups: { ids: string[] }[]): string[][] => groups.map((g) => [...g.ids].sort())

describe('mergeBySubject', () => {
  it('merges two dense clusters that are one subject to a person', () => {
    const merged = mergeBySubject(COMMUNITIES, titleOf, ADJ)
    const topic = merged.find((g) => g.ids.includes('a1'))!
    expect([...topic.ids].sort()).toEqual([...TOPIC_PRIMARY.ids, ...TOPIC_SECONDARY.ids].sort())
    // ...and names it, so the boundary change carries a label with it.
    expect(topic.subject).toBe('Workspace')
  })

  it('never merges clusters that only share a project prefix', () => {
    const merged = mergeBySubject(COMMUNITIES, titleOf, ADJ)
    expect(merged).toHaveLength(5) // 6 communities, exactly one merge
    for (const cluster of [PROJECT_LOCALE, PROJECT_MESSAGES, PROJECT_ACCESS, PROJECT_EXPORT]) {
      const group = merged.find((g) => g.ids.includes(cluster.ids[0]!))!
      expect([...group.ids].sort()).toEqual([...cluster.ids].sort())
      expect(group.subject).toBeNull()
    }
  })

  it('drops ticket tokens, so a shared ticket prefix is not even a candidate', () => {
    expect(titleTokens('[PROJECT-244] 코드 인터프리터 다단계 작업 중단')).toEqual([
      '코드',
      '인터프리터',
      '다단계',
      '작업',
      '중단',
    ])
    const ticketed = ALL.map((c) => c.ids)
    const withTickets = (id: string): string =>
      titleOf(id).replace(/^PROJECT /, `[PROJECT-${id.slice(1)}00] `)
    const merged = mergeBySubject(ticketed, withTickets, ADJ)
    expect(merged).toHaveLength(5)
  })

  it('refuses a subject the link graph does not back — no edge, no merge', () => {
    const isolated = adjOf([...ALL.flatMap((c) => clique(c.ids))])
    const merged = mergeBySubject(COMMUNITIES, titleOf, isolated)
    expect(merged).toHaveLength(6)
    expect(merged.every((g) => g.subject === null)).toBe(true)
  })

  it('refuses a word that only one side is about', () => {
    const half = community('h', [
      'Workspace draft create',
      'Workspace draft rename',
      'Storage quota update',
      'Search ranking update',
      'Network timeout update',
      'Cache expiry update',
    ])
    const lookup = (id: string): string => half.titles.get(id) ?? titleOf(id)
    const adj = adjOf([...clique(half.ids), ...clique(TOPIC_SECONDARY.ids), ['h1', 'b1']])
    const merged = mergeBySubject([half.ids, TOPIC_SECONDARY.ids], lookup, adj)
    expect(merged).toHaveLength(2)
  })

  it('is deterministic — same vault, same topics, whatever order it arrives in', () => {
    const once = mergeBySubject(COMMUNITIES, titleOf, ADJ)
    const twice = mergeBySubject(COMMUNITIES, titleOf, ADJ)
    const reversed = mergeBySubject([...COMMUNITIES].reverse(), titleOf, ADJ)
    const shuffledMembers = mergeBySubject(
      COMMUNITIES.map((ids) => [...ids].reverse()),
      titleOf,
      ADJ,
    )
    expect(idsOf(twice)).toEqual(idsOf(once))
    expect(idsOf(reversed)).toEqual(idsOf(once))
    expect(idsOf(shuffledMembers)).toEqual(idsOf(once))
    expect(reversed.map((g) => g.subject)).toEqual(once.map((g) => g.subject))
    expect(shuffledMembers.map((g) => g.subject)).toEqual(once.map((g) => g.subject))
  })
})

const NOW = '2026-07-26T00:00:00.000Z'
function noteOf(id: string, title: string, derived: string[]): Note {
  return {
    front: {
      id, type: 'note', status: 'current', supersedes: [], derived_from: derived,
      decay: 'slow', timeline: 'inferred', created: NOW, updated: NOW,
    },
    body: `# ${title}\n\n내용`,
  }
}

describe('linkComponents with the subject merge', () => {
  // Merging BEFORE the size filter is the point: two halves of one subject that
  // each fall under HUB_MIN_NOTES would otherwise both be dropped and the topic
  // would never get a hub at all.
  it('merges two same-subject communities into one topic that earns a hub', () => {
    const notes = [
      ...TOPIC_PRIMARY.ids.map((id, i) =>
        noteOf(id, TOPIC_PRIMARY.titles.get(id)!, TOPIC_PRIMARY.ids.slice(0, i)),
      ),
      ...TOPIC_SECONDARY.ids.map((id, i) =>
        noteOf(id, TOPIC_SECONDARY.titles.get(id)!, [...TOPIC_SECONDARY.ids.slice(0, i), ...(i === 0 ? ['a1'] : [])]),
      ),
    ]
    const topics = linkComponents(notes)
    expect(topics).toHaveLength(1)
    expect(topics[0]!.members).toHaveLength(TOPIC_PRIMARY.ids.length + TOPIC_SECONDARY.ids.length)
    expect(topics[0]!.subject).toBe('Workspace')
  })
})
