import { describe, expect, it } from 'vitest'
import { mergeBySubject } from '../src/jobs/subject.js'

function chain(prefix: string, groups: number): { communities: string[][]; titles: Map<string, string>; adj: Map<string, Set<string>> } {
  const communities: string[][] = []
  const titles = new Map<string, string>()
  const adj = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  for (let g = 0; g < groups; g += 1) {
    const ids = [0, 1, 2, 3].map((i) => `${prefix}${g}-${i}`)
    for (const id of ids) titles.set(id, `${prefix} ${['하나', '둘', '셋', '넷'][Number(id.slice(-1))]}`)
    for (const a of ids) for (const b of ids) if (a < b) link(a, b)
    communities.push(ids)
    // one edge to the previous group — dense inside, joined across
    if (g > 0) link(`${prefix}${g - 1}-0`, `${prefix}${g}-0`)
  }
  return { communities, titles, adj }
}

const { communities, titles, adj } = chain('SATURN', 4)
const titleOf = (id: string) => titles.get(id)!
const merge = (known?: Parameters<typeof mergeBySubject>[3]) => mergeBySubject(communities, titleOf, adj, known)

describe('four linked clusters sharing one dominant word', () => {
  it('stays split when nothing has been declared — the cautious default', () => {
    expect(merge()).toHaveLength(4)
  })

  it('stays split when the word is declared an umbrella', () => {
    expect(merge({ umbrella: ['saturn'] })).toHaveLength(4)
  })

  it('becomes one topic when the word is declared a name', () => {
    const merged = merge({ aliases: [['SATURN', '새턴']] })
    expect(merged).toHaveLength(1)
    expect(merged[0]!.subject).toBe('SATURN')
  })

  it('lets umbrella win over an alias entry, because refusing to merge is the safe error', () => {
    expect(merge({ aliases: [['SATURN', '새턴']], umbrella: ['saturn'] })).toHaveLength(4)
  })

  it('ignores declarations about words this vault does not use', () => {
    expect(merge({ aliases: [['Quokka', 'Wombat']], umbrella: ['zebra'] })).toHaveLength(4)
  })

  // A declaration is permission to merge, not a command: the clusters must
  // still be linked and the word must still be what each pile is about.
  it('does not merge clusters the link graph never joined', () => {
    const loose = chain('SATURN', 3)
    loose.adj.delete('SATURN0-0')
    for (const set of loose.adj.values()) set.delete('SATURN0-0')
    const merged = mergeBySubject(loose.communities, (id) => loose.titles.get(id)!, loose.adj, {
      aliases: [['SATURN', '새턴']],
    })
    expect(merged.length).toBeGreaterThan(1)
  })
})
