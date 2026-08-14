import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteDto } from '../../../shared/types.js'
import { useApp } from '../state.js'
import { freshTone, stripEmoji } from '../lib/grouping.js'
import { VH, VW, pickStars, shapeDigest, solvePositions } from '../lib/skyLayout.js'
import { SkyCanvas } from './sky/SkyCanvas.js'
import type { SkyNode } from './sky/draw.js'
import { FULL_VIEW, type View } from './sky/hit.js'

const IGNITE_WINDOW_MS = 3 * 60_000
const RECALL_HALO_MS = 7 * 86_400_000

export function BrainGraph({ notes, onOpen, focus, onFocusConsumed }: {
  notes: NoteDto[]
  onOpen: (id: string) => void
  // Stars to spotlight on mount (the "View in the cosmos" hand-off): members
  // light up + halo, the rest fade. Consumed once via onFocusConsumed.
  focus?: { ids: string[] } | null
  onFocusConsumed?: () => void
}) {
  const picked = useMemo(() => pickStars(notes), [notes])
  const shape = useMemo(() => shapeDigest(picked), [picked])

  // Positions re-solve ONLY when the shape moves. pickedRef dodges the stale
  // closure: for one digest every picked array is positionally equivalent, so
  // reading the latest is safe — and it keeps `picked` out of the memo key.
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const { pos, edges, neighbors, order } = useMemo(() => solvePositions(pickedRef.current), [shape])

  // Meaning-level threads: fabric pairs whose both stars are on this sky and
  // that no written link already covers. Visual only — the solver never sees
  // them, so association cannot move the constellations around.
  const { fabric } = useApp()
  const fabricPairs = useMemo(() => {
    if (fabric.edges.length === 0) return []
    const indexOf = new Map(picked.map((n, i) => [n.id, i]))
    const linked = new Set(edges.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`))
    const out: [number, number][] = []
    for (const e of fabric.edges) {
      const a = indexOf.get(e.a)
      const b = indexOf.get(e.b)
      if (a === undefined || b === undefined) continue
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`
      if (linked.has(key)) continue
      linked.add(key)
      out.push([a, b])
    }
    return out
  }, [fabric, picked, edges])

  // Dressing refreshes every publish — freshness dims, recall halos, ignition
  // flashes — without touching the solved sky.
  const nodes: SkyNode[] = useMemo(() => {
    const now = Date.now()
    return picked.map((n, i) => ({
      id: n.id,
      title: stripEmoji(n.title),
      hub: n.type === 'hub',
      tone: freshTone(n.badge),
      activation: n.activation,
      ignite: now - Date.parse(n.created) < IGNITE_WINDOW_MS,
      recalled: n.last_recalled !== undefined && now - Date.parse(n.last_recalled) < RECALL_HALO_MS,
      x: pos[i]?.x ?? VW / 2,
      y: pos[i]?.y ?? VH / 2,
    }))
  }, [picked, pos])

  const [view, setView] = useState<View>(FULL_VIEW)

  const [spotlight, setSpotlight] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!focus || focus.ids.length === 0) return
    const ids = new Set(focus.ids)
    setSpotlight(ids)
    onFocusConsumed?.()
    const members = nodes.filter((n) => ids.has(n.id))
    if (members.length === 0) return
    const pad = 70
    const minX = Math.min(...members.map((n) => n.x)) - pad
    const maxX = Math.max(...members.map((n) => n.x)) + pad
    const minY = Math.min(...members.map((n) => n.y)) - pad
    const maxY = Math.max(...members.map((n) => n.y)) + pad
    // Fit the cluster's box to the virtual aspect; never zoom past the wheel's
    // own comfort range, never wider than the full sky.
    const w = Math.min(Math.max(maxX - minX, ((maxY - minY) * VW) / VH, VW / 4), VW)
    const h = (w / VW) * VH
    setView({ x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h })
  }, [focus, nodes, onFocusConsumed])

  const clearSpotlight = useCallback(() => setSpotlight(null), [])

  // A single memory is still a sky (Engram: the first star must show).
  if (nodes.length < 1) return null

  return (
    <SkyCanvas
      nodes={nodes}
      edges={edges}
      fabric={fabricPairs}
      neighbors={neighbors}
      order={order}
      spotlight={spotlight}
      view={view}
      onViewChange={setView}
      onOpen={onOpen}
      onClearSpotlight={clearSpotlight}
    />
  )
}
