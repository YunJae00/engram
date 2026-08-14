import { describe, expect, it } from 'vitest'
import { topicComponents, type Adjacency } from '../src/jobs/graph.js'

function adjOf(edges: [string, string][]): Adjacency {
  const adj: Adjacency = new Map()
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  return adj
}

const chain = (ids: string[]): [string, string][] => ids.slice(1).map((id, i) => [ids[i]!, id])
// A clique — the shape of a real topic, where members cite each other.
const clique = (ids: string[]): [string, string][] =>
  ids.flatMap((a, i) => ids.slice(i + 1).map((b): [string, string] => [a, b]))

describe('topicComponents — link communities', () => {
  it('separates two topics welded by a multi-topic note', () => {
    const edges: [string, string][] = [
      ...clique(['a1', 'a2', 'a3', 'a4']),
      ...clique(['b1', 'b2', 'b3', 'b4']),
      ['r', 'a1'], ['r', 'a2'], ['r', 'b1'],
    ]
    const comps = topicComponents(adjOf(edges))
    expect(comps).toHaveLength(2)
    // r lands with A, where most of its links live.
    const withR = comps.find((c) => c.includes('r'))!
    expect(withR.filter((id) => id.startsWith('a'))).toHaveLength(4)
    expect(comps.find((c) => !c.includes('r'))!.sort()).toEqual(['b1', 'b2', 'b3', 'b4'])
  })

  // A young vault is mostly short lineages, which have no dense core —
  // modularity alone would hand back two topics of two.
  it('keeps a short lineage chain as ONE topic', () => {
    expect(topicComponents(adjOf(chain(['c1', 'c2', 'c3', 'c4'])))).toEqual([['c1', 'c2', 'c3', 'c4']])
  })

  // The failure that motivated the rewrite: with FIVE dump notes bridging two
  // projects, no single removal disconnects anything, so the old
  // articulation-point cut left all 13 notes welded in one topic.
  it('separates topics joined by MANY parallel bridges', () => {
    const edges: [string, string][] = [
      ...clique(['a1', 'a2', 'a3', 'a4']),
      ...clique(['b1', 'b2', 'b3', 'b4']),
      ...['d1', 'd2', 'd3', 'd4', 'd5'].flatMap((d): [string, string][] => [[d, 'a1'], [d, 'b1']]),
    ]
    const comps = topicComponents(adjOf(edges))
    expect(comps.length).toBeGreaterThanOrEqual(2)
    // The two projects never share a topic.
    const topicOf = new Map(comps.flatMap((c, i) => c.map((id) => [id, i] as const)))
    expect(topicOf.get('a2')).not.toBe(topicOf.get('b2'))
    expect(topicOf.get('a2')).toBe(topicOf.get('a3'))
    expect(topicOf.get('b2')).toBe(topicOf.get('b3'))
  })

  it('never splits a genuinely central note away from its own topic', () => {
    // A star: k is the hub of ONE topic, not a bridge between two.
    const edges: [string, string][] = [
      ['k', 'n1'], ['k', 'n2'], ['k', 'n3'], ['k', 'n4'], ['k', 'n5'], ['k', 'n6'], ['k', 'n7'],
    ]
    const comps = topicComponents(adjOf(edges))
    expect(comps).toHaveLength(1)
    expect(comps[0]).toHaveLength(8)
  })

  it('keeps unrelated components apart and never invents links', () => {
    const comps = topicComponents(adjOf([...clique(['a1', 'a2', 'a3']), ...clique(['b1', 'b2', 'b3'])]))
    expect(comps.map((c) => c.sort())).toEqual([['a1', 'a2', 'a3'], ['b1', 'b2', 'b3']])
  })

  it('returns every node exactly once', () => {
    const edges: [string, string][] = [
      ...clique(['a1', 'a2', 'a3', 'a4']),
      ...clique(['b1', 'b2', 'b3']),
      ['r', 'a1'], ['r', 'b1'],
    ]
    const comps = topicComponents(adjOf(edges))
    const all = comps.flat().sort()
    expect(all).toEqual(['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'r'])
    expect(new Set(all).size).toBe(all.length)
  })

  it('is deterministic', () => {
    const edges: [string, string][] = [
      ...chain(['a1', 'a2', 'a3', 'a4']),
      ...chain(['b1', 'b2', 'b3', 'b4']),
      ['r', 'a1'], ['r', 'b1'], ['r', 'b2'],
    ]
    const one = topicComponents(adjOf(edges)).map((c) => [...c].sort().join(','))
    const two = topicComponents(adjOf(edges)).map((c) => [...c].sort().join(','))
    expect(one).toEqual(two)
  })
})
