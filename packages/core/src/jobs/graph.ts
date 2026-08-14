
export type Adjacency = Map<string, Set<string>>

const RESOLUTION = 1
// Local moving converges in a handful of passes; the cap is a safety net.
const MAX_PASSES = 20

type Weighted = Map<number, Map<number, number>>

// One local-moving phase over a weighted graph. `self` holds each node's
// self-loop weight (edges folded inside it by a previous aggregation).
// Returns the community index per node, renumbered from 0.
function localMoving(adj: Weighted, self: number[]): number[] {
  const n = self.length
  const k: number[] = []
  for (let i = 0; i < n; i++) {
    let sum = self[i]! * 2
    for (const w of adj.get(i)?.values() ?? []) sum += w
    k.push(sum)
  }
  const m2 = k.reduce((a, b) => a + b, 0)
  const community = k.map((_, i) => i)
  if (m2 > 0) {
    const totalDegree = k.slice()
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let moved = 0
      for (let i = 0; i < n; i++) {
        const from = community[i]!
        const linksTo = new Map<number, number>()
        for (const [j, w] of adj.get(i) ?? []) {
          const c = community[j]!
          linksTo.set(c, (linksTo.get(c) ?? 0) + w)
        }
        // Pull the node out first, so staying put is judged on equal terms.
        totalDegree[from] = totalDegree[from]! - k[i]!
        let best = from
        let bestGain = (linksTo.get(from) ?? 0) - (RESOLUTION * totalDegree[from]! * k[i]!) / m2
        for (const c of [...linksTo.keys()].sort((a, b) => a - b)) {
          const gain = linksTo.get(c)! - (RESOLUTION * totalDegree[c]! * k[i]!) / m2
          if (gain > bestGain + 1e-12) {
            bestGain = gain
            best = c
          }
        }
        totalDegree[best] = totalDegree[best]! + k[i]!
        if (best !== from) {
          community[i] = best
          moved++
        }
      }
      if (moved === 0) break
    }
  }
  const renumbered = new Map<number, number>()
  return community.map((c) => {
    let index = renumbered.get(c)
    if (index === undefined) {
      index = renumbered.size
      renumbered.set(c, index)
    }
    return index
  })
}

function communitiesOf(source: Adjacency): string[][] {
  const ids = [...source.keys()].sort()
  const indexOf = new Map(ids.map((id, i) => [id, i]))
  let adj: Weighted = new Map(
    ids.map((id, i) => [
      i,
      new Map(
        [...(source.get(id) ?? [])]
          .map((n): [number, number] => [indexOf.get(n)!, 1])
          .filter(([j]) => j !== i),
      ),
    ]),
  )
  let self = ids.map(() => 0)
  // original node index -> its node at the current level
  let level = ids.map((_, i) => i)

  for (let round = 0; round < MAX_PASSES; round++) {
    const community = localMoving(adj, self)
    const count = new Set(community).size
    if (count === self.length) break // nothing merged — converged
    level = level.map((node) => community[node]!)

    // Aggregate: one super-node per community, carrying its internal weight.
    const nextAdj: Weighted = new Map(Array.from({ length: count }, (_, i) => [i, new Map()]))
    const nextSelf = new Array<number>(count).fill(0)
    for (let i = 0; i < self.length; i++) {
      const c = community[i]!
      nextSelf[c] = (nextSelf[c] ?? 0) + self[i]!
    }
    for (const [i, edges] of adj) {
      for (const [j, w] of edges) {
        if (j < i) continue // each undirected edge once
        const a = community[i]!
        const b = community[j]!
        if (a === b) nextSelf[a] = (nextSelf[a] ?? 0) + w
        else {
          nextAdj.get(a)!.set(b, (nextAdj.get(a)!.get(b) ?? 0) + w)
          nextAdj.get(b)!.set(a, (nextAdj.get(b)!.get(a) ?? 0) + w)
        }
      }
    }
    adj = nextAdj
    self = nextSelf
  }

  const grouped = new Map<number, string[]>()
  ids.forEach((id, i) => {
    const c = level[i]!
    if (!grouped.has(c)) grouped.set(c, [])
    grouped.get(c)!.push(id)
  })

  // Local moving can leave a community whose members aren't all reachable from
  // each other. A topic shown to the user must be ONE linked cluster, so split
  // each community on its own connectivity.
  const out: string[][] = []
  for (const members of grouped.values()) {
    const inCommunity = new Set(members)
    const seen = new Set<string>()
    for (const start of members) {
      if (seen.has(start)) continue
      const part: string[] = []
      const queue = [start]
      seen.add(start)
      while (queue.length > 0) {
        const cur = queue.pop()!
        part.push(cur)
        for (const neighbor of source.get(cur) ?? []) {
          if (!inCommunity.has(neighbor) || seen.has(neighbor)) continue
          seen.add(neighbor)
          queue.push(neighbor)
        }
      }
      out.push(part.sort())
    }
  }
  return out
}

// Connected components — the outer frame. Communities are only looked for
// INSIDE a component, and only once it is big enough to plausibly hold more
// than one topic: modularity has no notion of "too small to bother", so on a
// short lineage (a → b → c → d, the shape a young vault is full of) it would
// happily return two topics of two. Below the threshold the component is one
// topic, full stop.
const MIN_SPLIT_COMPONENT = 8

export function topicComponents(source: Adjacency): string[][] {
  const seen = new Set<string>()
  const out: string[][] = []
  for (const start of [...source.keys()].sort()) {
    if (seen.has(start)) continue
    const component: string[] = []
    const queue = [start]
    seen.add(start)
    while (queue.length > 0) {
      const cur = queue.pop()!
      component.push(cur)
      for (const neighbor of source.get(cur) ?? []) {
        if (seen.has(neighbor)) continue
        seen.add(neighbor)
        queue.push(neighbor)
      }
    }
    if (component.length < MIN_SPLIT_COMPONENT) {
      out.push(component.sort())
      continue
    }
    const inComponent = new Set(component)
    const sub: Adjacency = new Map(
      component.map((id) => [id, new Set([...(source.get(id) ?? [])].filter((n) => inComponent.has(n)))]),
    )
    out.push(...communitiesOf(sub))
  }
  return out.sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1))
}
