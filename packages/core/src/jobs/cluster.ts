import { expandQueryWithAliases } from '../aliases.js'
import type { Note } from '../schema.js'
import { noteTitle } from '../schema.js'
import { buildIndexAsync, searchIndex } from '../search.js'

const J7_QUERY_HEAD = 100
const J7_EDGE_THRESHOLD = 40
const J7_CLUSTER_CAP = 30
const CLUSTER_YIELD_EVERY = 200

export async function findMergeClusters(
  current: Note[],
  aliasGroups: string[][] = [],
  seeds: Note[] = current,
): Promise<Note[][]> {
  if (current.length < 2) return []
  const index = await buildIndexAsync(current, { cjkNgrams: false })
  const byId = new Map(current.map((n) => [n.front.id, n]))
  const edges = new Map<string, number>()
  let scanned = 0
  for (const note of seeds) {
    const query = expandQueryWithAliases(`${noteTitle(note)} ${note.body.slice(0, J7_QUERY_HEAD)}`, aliasGroups)
    for (const hit of searchIndex(index, query)) {
      if (hit.id === note.front.id || hit.score < J7_EDGE_THRESHOLD) continue
      const [a, b] = note.front.id < hit.id ? [note.front.id, hit.id] : [hit.id, note.front.id]
      const key = `${a}\t${b}`
      const prev = edges.get(key)
      if (prev === undefined || hit.score > prev) edges.set(key, hit.score)
    }
    if (++scanned % CLUSTER_YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve))
  }
  if (edges.size === 0) return []
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
    .sort((x, y) => y.best - x.best || (x.lowId < y.lowId ? -1 : x.lowId > y.lowId ? 1 : 0))
    .slice(0, J7_CLUSTER_CAP)
    .map((c) => c.notes)
}
