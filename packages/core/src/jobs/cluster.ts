import { expandQueryWithAliases } from '../aliases.js'
import type { Note } from '../schema.js'
import { noteTitle } from '../schema.js'
import { buildIndex, searchIndex } from '../search.js'

// J7 deterministic pre-pairing. The weekly merge scan used to embed the WHOLE
// current corpus in the prompt (linear token growth). Instead we cluster
// near-duplicates locally at ZERO token cost: index the current notes once,
// query each by its title + head, and join any pair whose retrieval score
// clears J7_EDGE_THRESHOLD into an undirected edge. Connected components of
// size ≥2 are the merge candidates that reach the engine.
const J7_QUERY_HEAD = 100
// Calibrated on the repo's note fixtures (search over title + 100-char head):
// tight near-duplicates score ~250–310 and same-topic rewrites ~90–125, while
// incidental single-phrase overlap between unrelated notes tops out near ~24.
// 40 sits in that gap — obvious dupes pair up, unrelated notes stay apart.
const J7_EDGE_THRESHOLD = 40
const J7_CLUSTER_CAP = 30

export function findMergeClusters(current: Note[], aliasGroups: string[][] = []): Note[][] {
  if (current.length < 2) return []
  // Plain tokenizer: the threshold above was calibrated without CJK bigrams.
  const index = buildIndex(current, { cjkNgrams: false })
  const byId = new Map(current.map((n) => [n.front.id, n]))
  // Undirected edges keyed "a\tb" (a<b) → best score seen in either direction.
  const edges = new Map<string, number>()
  for (const note of current) {
    // Taught aliases join the query, so notes filed under the OTHER name of
    // the same thing can reach the pairing threshold despite disjoint text.
    const query = expandQueryWithAliases(`${noteTitle(note)} ${note.body.slice(0, J7_QUERY_HEAD)}`, aliasGroups)
    for (const hit of searchIndex(index, query)) {
      if (hit.id === note.front.id || hit.score < J7_EDGE_THRESHOLD) continue
      const [a, b] = note.front.id < hit.id ? [note.front.id, hit.id] : [hit.id, note.front.id]
      const key = `${a}\t${b}`
      const prev = edges.get(key)
      if (prev === undefined || hit.score > prev) edges.set(key, hit.score)
    }
  }
  if (edges.size === 0) return []
  // Union-Find over edge endpoints → connected components.
  const parent = new Map<string, string>()
  const root = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const parsed = [...edges].map(([key, score]) => {
    const [a, b] = key.split('\t') as [string, string]
    return { a, b, score }
  })
  for (const e of parsed) {
    if (!parent.has(e.a)) parent.set(e.a, e.a)
    if (!parent.has(e.b)) parent.set(e.b, e.b)
    const ra = root(e.a)
    const rb = root(e.b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const members = new Map<string, string[]>()
  const best = new Map<string, number>()
  for (const id of [...parent.keys()]) {
    const r = root(id)
    const list = members.get(r)
    if (list) list.push(id)
    else members.set(r, [id])
  }
  for (const e of parsed) {
    const r = root(e.a)
    const prev = best.get(r)
    if (prev === undefined || e.score > prev) best.set(r, e.score)
  }
  return [...members.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([r, ids]) => {
      const sorted = [...ids].sort()
      return { notes: sorted.map((id) => byId.get(id)!), best: best.get(r) ?? 0, lowId: sorted[0]! }
    })
    // Deterministic: strongest cluster first, ties broken by lowest member id.
    .sort((x, y) => y.best - x.best || (x.lowId < y.lowId ? -1 : x.lowId > y.lowId ? 1 : 0))
    .slice(0, J7_CLUSTER_CAP)
    .map((c) => c.notes)
}
