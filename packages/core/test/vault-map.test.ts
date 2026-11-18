import { describe, expect, it } from 'vitest'
import { topicComponents, type Adjacency } from '../src/jobs/graph.js'

function adjOf(edges: [string, string][]): Adjacency {
  const adj: Adjacency = new Map()
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a)!.add(b)
  }
  for (const [a, b] of edges) {
    link(a, b)
    link(b, a)
  }
  return adj
}

describe('topicComponents for the chat vault map', () => {
  it('separates two unrelated clusters into two topics', () => {
    const comps = topicComponents(adjOf([['a1', 'a2'], ['a2', 'a3'], ['b1', 'b2']]))
    const sizes = comps.map((c) => c.length).sort((x, y) => y - x)
    expect(sizes).toEqual([3, 2])
    const a = comps.find((c) => c.includes('a1'))!
    expect(a).toContain('a3')
    expect(a).not.toContain('b1')
  })

  it('a note with no links is not part of any topic (excluded from the map)', () => {
    const comps = topicComponents(adjOf([['a1', 'a2']]))
    expect(comps.flat()).not.toContain('loose')
    expect(comps).toHaveLength(1)
  })
})
