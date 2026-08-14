import type { NoteDto } from '../../../shared/types.js'
import { deriveTopicLabel, shortTopicLabel } from './topicLabel.js'
import { mergeBySubject, type SubjectKnowledge } from './topicSubject.js'

// The brain model: connected components of the librarian's link graph, viewed
// as TOPICS. Pure functions (no React, no IPC) driving the Brain view
// (pages, min 2).

interface LinkGraph {
  components: { members: NoteDto[]; subject: string | null }[]
  degree: Map<string, number>
}

// ── Topic communities — MIRROR of packages/core/src/jobs/graph.ts (the
// renderer cannot import core; keep the two in lockstep). Connected
// components welded unrelated projects together whenever a few "everything
// I'm working on" dump notes linked into all of them; modularity asks
// "densely connected compared to chance?" instead, so bridges lose. See the
// core file for the full rationale.
type Adjacency = Map<string, Set<string>>
const RESOLUTION = 1
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

function topicComponents(source: Adjacency): string[][] {
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

// Publishes burst during sweeps (many deltas re-derive the same pool) —
// memoise per pool array identity so each snapshot pays for the graph once.
const graphCache = new WeakMap<NoteDto[], Map<string, LinkGraph>>()

export interface FabricEdge {
  a: string
  b: string
  w: number
}

// Topics of the derived_from graph plus the similarity fabric. Hub notes are
// not graph nodes — their spokes would weld every component they touch into
// one blob; hubs are matched to a topic afterwards (they label it, not join
// it). Same-subject communities are merged (see topicSubject.ts) BEFORE the
// size filter, so two small halves of one subject become one topic rather
// than two dropped scraps. Topics below `minSize` are dropped; largest-first.
function linkComponentsOf(
  pool: NoteDto[],
  minSize: number,
  known: SubjectKnowledge = {},
  fabric: FabricEdge[] = [],
): LinkGraph {
  let byKey = graphCache.get(pool)
  if (!byKey) {
    byKey = new Map()
    graphCache.set(pool, byKey)
  }
  // The declared names and the fabric are part of the input, so they belong in
  // the cache key — otherwise editing workspace/aliases.md (or an embedding
  // pass reweaving the fabric) would leave the Brain showing the grouping it
  // computed before, for as long as the note array lived.
  const key = `${minSize}|${(known.aliases ?? []).map((g) => g.join('=')).sort().join(';')}|${(known.umbrella ?? [])
    .slice()
    .sort()
    .join(';')}|${fabric.length}:${fabric.map((e) => e.a + e.b).join('').length}`
  const hit = byKey.get(key)
  if (hit) return hit
  const fresh = computeLinkGraph(pool, minSize, known, fabric)
  byKey.set(key, fresh)
  return fresh
}

function computeLinkGraph(pool: NoteDto[], minSize: number, known: SubjectKnowledge, fabric: FabricEdge[]): LinkGraph {
  const eligible = pool.filter((n) => n.type !== 'hub')
  const byId = new Map(eligible.map((n) => [n.id, n]))
  const adjacent: Adjacency = new Map()
  const degree = new Map<string, number>()
  const link = (a: string, b: string) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return
    if (!adjacent.has(a)) adjacent.set(a, new Set())
    if (!adjacent.has(b)) adjacent.set(b, new Set())
    adjacent.get(a)!.add(b)
    adjacent.get(b)!.add(a)
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }
  for (const n of eligible) for (const rel of n.derived_from) link(n.id, rel)
  for (const e of fabric) link(e.a, e.b)

  const components = mergeBySubject(topicComponents(adjacent), (id) => byId.get(id)!.title, adjacent, known)
    .filter((topic) => topic.ids.length >= minSize)
    .map((topic) => ({ members: topic.ids.map((id) => byId.get(id)!), subject: topic.subject }))
  return { components, degree }
}

// Does this hub still describe this exact pile? MIRRORS hubCoversTopic in
// core's jobs/hub.ts, which is what decides whether J9 renames it.
function hubCoversTopic(hub: NoteDto | null, ids: ReadonlySet<string>): boolean {
  if (!hub || hub.derived_from.length !== ids.size) return false
  return hub.derived_from.every((rel) => ids.has(rel))
}

// The hub covering a component: the one sharing the most members (≥2 — one
// shared id is coincidence, not identity). `taken` prevents one hub from
// fronting two components.
function matchTopicHub(hubs: NoteDto[], memberIds: ReadonlySet<string>, taken: ReadonlySet<string>): NoteDto | null {
  let best: NoteDto | null = null
  let bestOverlap = 1
  for (const hub of hubs) {
    if (taken.has(hub.id)) continue
    const overlap = hub.derived_from.filter((rel) => memberIds.has(rel)).length
    if (overlap > bestOverlap) {
      best = hub
      bestOverlap = overlap
    }
  }
  return best
}

export interface Topic {
  // Stable identity across recomputes: the smallest member id.
  key: string
  title: string
  hub: NoteDto | null
  // Excluding the hub, newest first (happened_at beats updated when present).
  members: NoteDto[]
  // 🔴+🟡 members — the topic's "needs a look" count.
  agingCount: number
}

interface BrainModel {
  topics: Topic[]
  // Live notes in no component (and hubs orphaned of one) — the loose neurons.
  unconnected: NoteDto[]
}

function memoryStamp(n: NoteDto): string {
  return n.happened_at ?? n.updated
}

function byMemoryDesc(a: NoteDto, b: NoteDto): number {
  const sa = memoryStamp(a)
  const sb = memoryStamp(b)
  return sa < sb ? 1 : sa > sb ? -1 : 0
}

// Brain pages use a low bar: two connected memories are already a thread
// worth reading.
const PAGE_MIN = 2

export function buildBrain(live: NoteDto[], known: SubjectKnowledge = {}, fabric: FabricEdge[] = []): BrainModel {
  const { components, degree } = linkComponentsOf(live, PAGE_MIN, known, fabric)
  const hubs = live.filter((n) => n.type === 'hub')
  const taken = new Set<string>()
  const placed = new Set<string>()

  const topics: Topic[] = components.map(({ members, subject }) => {
    const ids = new Set(members.map((m) => m.id))
    const hub = matchTopicHub(hubs, ids, taken)
    if (hub) taken.add(hub.id)
    const covers = hubCoversTopic(hub, ids)
    const anchor = [...members].sort(
      (a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || byMemoryDesc(a, b),
    )[0]!
    for (const m of members) placed.add(m.id)
    if (hub) placed.add(hub.id)
    return {
      key: [...ids].sort()[0]!,
      // A hub's title, shortened to its head — the librarian often writes a
      // descriptive subtitle after a colon, but the topic label must stay a
      // simple theme (the detail belongs to the synthesis and the members).
      // Without a usable hub the label is the merged subject, else derived from
      // what member titles share.
      title:
        hub && covers
          ? shortTopicLabel(hub.title)
          : (subject ??
            (hub
              ? shortTopicLabel(hub.title)
              : deriveTopicLabel(anchor.title, [
                  anchor.title,
                  ...members.filter((m) => m !== anchor).map((m) => m.title),
                ]))),
      hub,
      members: [...members].sort(byMemoryDesc),
      agingCount: members.filter((m) => m.badge === '🔴' || m.badge === '🟡').length,
    }
  })

  const unconnected = live.filter((n) => !placed.has(n.id)).sort(byMemoryDesc)
  return { topics, unconnected }
}
