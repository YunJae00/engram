import type { Note } from './schema.js'

// Lineage graph from supersedes[] edges (newer → older). Append-mostly means
// the chain IS the history.

export interface LineageGraph {
  byId: Map<string, Note>
  // olderId → newer ids that supersede it
  supersededBy: Map<string, string[]>
}

export function buildLineage(notes: Note[]): LineageGraph {
  const byId = new Map<string, Note>()
  const supersededBy = new Map<string, string[]>()
  for (const note of notes) byId.set(note.front.id, note)
  for (const note of notes) {
    for (const oldId of note.front.supersedes) {
      const list = supersededBy.get(oldId) ?? []
      list.push(note.front.id)
      supersededBy.set(oldId, list)
    }
  }
  return { byId, supersededBy }
}

// Transitive closure over supersedes[] (this note's ancestry, oldest last).
export function ancestorsOf(graph: LineageGraph, id: string): Note[] {
  const seen = new Set<string>()
  const out: Note[] = []
  const walk = (cur: string) => {
    const note = graph.byId.get(cur)
    if (!note) return
    for (const oldId of note.front.supersedes) {
      if (seen.has(oldId)) continue
      seen.add(oldId)
      const old = graph.byId.get(oldId)
      if (old) out.push(old)
      walk(oldId)
    }
  }
  walk(id)
  return out
}

// Notes that (transitively) supersede this one, newest last.
export function descendantsOf(graph: LineageGraph, id: string): Note[] {
  const seen = new Set<string>()
  const out: Note[] = []
  const walk = (cur: string) => {
    for (const newerId of graph.supersededBy.get(cur) ?? []) {
      if (seen.has(newerId)) continue
      seen.add(newerId)
      const newer = graph.byId.get(newerId)
      if (newer) out.push(newer)
      walk(newerId)
    }
  }
  walk(id)
  return out
}

// Full chain through a note, oldest → newest (for the lineage strip UI).
export function chainOf(graph: LineageGraph, id: string): Note[] {
  const self = graph.byId.get(id)
  if (!self) return []
  const chain = [...ancestorsOf(graph, id).reverse(), self, ...descendantsOf(graph, id)]
  return chain.sort((a, b) => Date.parse(a.front.created) - Date.parse(b.front.created))
}

export interface ChronologyInversion {
  newerId: string
  olderId: string
}

// A supersedes B but happened before it → card ⑥ material.
export function detectInversions(notes: Note[]): ChronologyInversion[] {
  const byId = new Map(notes.map((n) => [n.front.id, n]))
  const out: ChronologyInversion[] = []
  for (const note of notes) {
    if (!note.front.happened_at) continue
    for (const oldId of note.front.supersedes) {
      const old = byId.get(oldId)
      if (!old?.front.happened_at) continue
      if (Date.parse(note.front.happened_at) < Date.parse(old.front.happened_at)) {
        out.push({ newerId: note.front.id, olderId: oldId })
      }
    }
  }
  return out
}
