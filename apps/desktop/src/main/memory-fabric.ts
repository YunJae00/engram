import { ipcMain } from 'electron'
import {
  ASSOCIATION_EDGE_FLOOR,
  loadNeighborRows,
  pruneNeighborRows,
  recordWarmth,
  saveNeighborRows,
  semanticEdges,
  updateNeighborRows,
  emptyNeighborRows,
  type NeighborRows,
  type SemanticEdge,
  type VectorIndex,
} from 'core'
import { flog } from './flog.js'
import type { VaultContext } from './vault.js'

// A fresh capture near an old note is a genuine re-encounter of the topic.
const ECHO_FRESH = 0.5
// Opening a note primes its neighbours more faintly.
const ECHO_RECALL = 0.3
// Only meaning-level matches echo; below this it is coincidence.
const ECHO_FLOOR = 0.6
const ECHO_TARGETS = 3
// Association edges must clear the same bar autoAssociate uses to write real
// links — the Brain grouping treats them as edges, and a wrong weld teaches
// the user to distrust every topic. The constant lives in core (neighbors.ts)
// because the sweep's consolidation drinks from the same floor.

let rows: NeighborRows | null = null
let ctxRef: VaultContext | null = null

export function startMemoryFabric(ctx: VaultContext): void {
  ctxRef = ctx
  rows = null // lazy-loaded on first use, per model
}

async function ensureRows(model: string): Promise<NeighborRows> {
  if (rows && rows.model === model) return rows
  rows = ctxRef ? ((await loadNeighborRows(ctxRef.paths, model)) ?? emptyNeighborRows(model)) : emptyNeighborRows(model)
  return rows
}

// Called by the semantic layer after every embedding pass: fold the freshly
// embedded notes into the fabric, prune the dead, persist — then let the echo
// out: each fresh note warms the already-existing notes it landed near.
export async function fabricAfterIndex(index: VectorIndex, freshIds: string[], liveIds: Set<string>): Promise<void> {
  if (!ctxRef) return
  try {
    const r = await ensureRows(index.model)
    const known = new Set(Object.keys(r.rows))
    updateNeighborRows(r, index, freshIds)
    pruneNeighborRows(r, liveIds)
    await saveNeighborRows(ctxRef.paths, r)
    let echoes = 0
    for (const id of freshIds.slice(0, 50)) {
      for (const hit of (r.rows[id] ?? []).slice(0, ECHO_TARGETS)) {
        // Only notes that were in the fabric BEFORE this pass: the echo means
        // "an old memory's topic came up again", not "two new notes arrived".
        if (!known.has(hit.id) || hit.cos < ECHO_FLOOR) continue
        await recordWarmth(ctxRef.paths, hit.id, ECHO_FRESH * hit.cos).catch(() => {})
        echoes++
      }
    }
    if (echoes > 0) flog('memory-fabric', `${echoes} re-exposure echoes from ${freshIds.length} fresh notes`)
  } catch (err) {
    flog('memory-fabric-failed', err)
  }
}

// Opening a memory primes its neighbourhood (spreading re-exposure, one hop).
export function echoRecall(id: string): void {
  const ctx = ctxRef
  if (!ctx || !rows) return
  void (async () => {
    for (const hit of (rows?.rows[id] ?? []).slice(0, ECHO_TARGETS)) {
      if (hit.cos < ECHO_FLOOR) continue
      await recordWarmth(ctx.paths, hit.id, ECHO_RECALL * hit.cos).catch(() => {})
    }
  })()
}

// The association edges the Brain grouping may treat as real links — pairs
// close enough that autoAssociate would have linked them. Empty when the
// semantic layer is off or the fabric has not been built yet, which
// degrades every consumer to the pure link graph.
export function associationEdges(): SemanticEdge[] {
  if (!rows) return []
  return semanticEdges(rows, ASSOCIATION_EDGE_FLOOR)
}

export function registerMemoryFabricIpc(): void {
  ipcMain.handle('brain:fabric', () => ({ edges: associationEdges() }))
}
