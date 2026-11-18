import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { VH, VW, skyProbe } from '../../lib/skyLayout.js'
import { Tween } from './anim.js'
import { drawSky, labelBudget, readPalette, zoomFactor, type Palette, type SkyNode } from './draw.js'
import { FULL_VIEW, pickNode, scaleOf, screenToWorld, worldToScreen, type Camera, type View } from './hit.js'

const GHOST = 12
const BUDGET_MS = 200
const EMPH_MS = 200

interface SkyCanvasProps {
  nodes: readonly SkyNode[]
  edges: readonly (readonly [number, number])[]
  fabric?: readonly (readonly [number, number])[]
  neighbors: readonly (readonly number[])[]
  order: readonly number[]
  spotlight: ReadonlySet<string> | null
  view: View
  onViewChange: (view: View) => void
  onOpen: (id: string) => void
  onClearSpotlight: () => void
}

function media(query: string): boolean {
  return typeof window !== 'undefined' && window.matchMedia(query).matches
}

export function SkyCanvas({ nodes, edges, fabric, neighbors, order, spotlight, view, onViewChange, onOpen, onClearSpotlight }: SkyCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
  const [palette, setPalette] = useState<Palette | null>(null)
  const [reduced, setReduced] = useState(() => media('(prefers-reduced-motion: reduce)'))

  const viewRef = useRef(view)
  const rafRef = useRef<number | null>(null)
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panRef = useRef<{ px: number; py: number; view: View } | null>(null)
  const movedRef = useRef(false)
  const hoverRef = useRef<{ id: string | null; prevId: string | null; since: number }>({
    id: null,
    prevId: null,
    since: -1e9,
  })
  const emphRef = useRef<{
    ids: ReadonlySet<string> | null
    from: Map<string, number>
    since: number
    now: Map<string, number>
    mirrored: ReadonlySet<string> | null
  }>({ ids: null, from: new Map(), since: -1e9, now: new Map(), mirrored: null })
  const ghostRef = useRef<HTMLDivElement>(null)
  const tierRef = useRef(-1)
  const budgetRef = useRef(new Tween(0))
  const spotRef = useRef<{ cur: ReadonlySet<string> | null; from: ReadonlySet<string> | null; since: number }>({
    cur: null,
    from: null,
    since: -1e9,
  })
  const firstRef = useRef(new Map<string, number>())
  const ignitedRef = useRef(new Map<string, number>())

  const paintRef = useRef<(ts: number) => boolean>(() => false)
  const schedule: () => void = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame((ts) => {
      rafRef.current = null
      if (paintRef.current(ts)) schedule()
    })
  }, [])

  const camera = useCallback((): Camera => ({ view: viewRef.current, cssW: size.w, cssH: size.h }), [size])

  const rank = useMemo(() => {
    const out = new Array<number>(nodes.length).fill(Infinity)
    let r = 0
    for (const i of order) if (nodes[i] && !nodes[i]!.hub) out[i] = r++
    return out
  }, [nodes, order])

  const mirrorGhosts = (ts: number) => {
    const emph = emphRef.current
    if (emph.mirrored === emph.ids) return
    if (!reduced && ts - emph.since < EMPH_MS) return
    const layer = ghostRef.current
    if (!layer) return
    for (const child of Array.from(layer.children)) {
      const id = child.getAttribute('data-node-id')
      if (!emph.ids) child.removeAttribute('data-sky-state')
      else child.setAttribute('data-sky-state', id && emph.ids.has(id) ? 'emph' : 'dim')
    }
    emph.mirrored = emph.ids
  }

  const setHover = (index: number, ts: number): boolean => {
    const id = index >= 0 ? nodes[index]!.id : null
    if (id === hoverRef.current.id) return false
    hoverRef.current = { id, prevId: hoverRef.current.id, since: ts }
    const ids =
      index >= 0
        ? new Set<string>([id!, ...(neighbors[index] ?? []).flatMap((j) => (nodes[j] ? [nodes[j]!.id] : []))])
        : null
    emphRef.current = { ...emphRef.current, ids, from: new Map(emphRef.current.now), since: ts }
    return true
  }

  paintRef.current = (ts: number) => {
    const canvas = canvasRef.current
    if (!canvas || !palette || size.w <= 0 || size.h <= 0) return false
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    skyProbe().frames++
    const cam = { view: viewRef.current, cssW: size.w, cssH: size.h }
    const { tier, limit } = labelBudget(zoomFactor(cam), tierRef.current, nodes.length)
    if (tierRef.current < 0 || reduced) budgetRef.current.set(limit)
    else budgetRef.current.to(limit, ts, BUDGET_MS)
    tierRef.current = tier

    const live = drawSky(ctx, {
      nodes,
      edges,
      fabric,
      cam,
      palette,
      now: ts,
      first: firstRef.current,
      ignited: ignitedRef.current,
      spot: spotRef.current.cur,
      spotFrom: spotRef.current.from,
      spotSince: spotRef.current.since,
      hover: hoverRef.current,
      emphasis: emphRef.current,
      labels: { small: nodes.length <= 12, rank, limit: budgetRef.current.value(ts) },
      reduced,
    })
    mirrorGhosts(ts)
    return live || budgetRef.current.live(ts)
  }

  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize((prev) => (Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5 ? prev : { w: r.width, h: r.height }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const next = window.devicePixelRatio || 1
    if (next !== dpr) setDpr(next)
    const mq = window.matchMedia(`(resolution: ${next}dppx)`)
    const onChange = () => setDpr(window.devicePixelRatio || 1)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [dpr, size])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w <= 0 || size.h <= 0) return
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    canvas.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0)
    schedule()
  }, [size, dpr, schedule])

  useEffect(() => {
    const root = document.documentElement
    const snap = () => setPalette(readPalette(root))
    snap()
    const mo = new MutationObserver(snap)
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', snap)
    return () => {
      mo.disconnect()
      mq.removeEventListener('change', snap)
    }
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    viewRef.current = view
    schedule()
  }, [view, schedule])

  useEffect(() => {
    const now = performance.now()
    const alive = new Set<string>()
    for (const n of nodes) {
      alive.add(n.id)
      if (!firstRef.current.has(n.id)) firstRef.current.set(n.id, now)
      if (n.ignite && !ignitedRef.current.has(n.id)) ignitedRef.current.set(n.id, now)
    }
    for (const id of firstRef.current.keys()) if (!alive.has(id)) firstRef.current.delete(id)
    for (const id of ignitedRef.current.keys()) if (!alive.has(id)) ignitedRef.current.delete(id)
    schedule()
  }, [nodes, edges, fabric, palette, reduced, schedule])

  useEffect(() => {
    if (spotlight === spotRef.current.cur) return
    spotRef.current = { cur: spotlight, from: spotRef.current.cur, since: performance.now() }
    schedule()
  }, [spotlight, schedule])

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current)
    },
    [],
  )

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const v = viewRef.current
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18
      const w = Math.min(Math.max(v.w * factor, VW / 6), VW * 1.6)
      const h = (w / VW) * VH
      const cam: Camera = { view: v, cssW: rect.width, cssH: rect.height }
      const { x: cx, y: cy } = screenToWorld(cam, e.clientX - rect.left, e.clientY - rect.top)
      viewRef.current = { x: cx - ((cx - v.x) / v.w) * w, y: cy - ((cy - v.y) / v.h) * h, w, h }
      schedule()
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current)
      wheelTimerRef.current = setTimeout(() => {
        wheelTimerRef.current = null
        onViewChange(viewRef.current)
      }, 120)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onViewChange, schedule])

  const endPan = (el: HTMLDivElement, overNode = false) => {
    panRef.current = null
    el.style.cursor = overNode ? 'pointer' : ''
  }

  const cam = { view, cssW: size.w, cssH: size.h }
  return (
    <div
      ref={hostRef}
      className="topic-graph"
      data-testid="brain-graph"
      onPointerDown={(e) => {
        panRef.current = { px: e.clientX, py: e.clientY, view: viewRef.current }
        movedRef.current = false
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const el = e.currentTarget
        const rect = el.getBoundingClientRect()
        const pan = panRef.current
        if (!pan) {
          const held = nodes.findIndex((n) => n.id === hoverRef.current.id)
          const idx = pickNode(nodes, camera(), e.clientX - rect.left, e.clientY - rect.top, held)
          if (setHover(idx, performance.now())) {
            el.style.cursor = idx >= 0 ? 'pointer' : ''
            schedule()
          }
          return
        }
        if (Math.abs(e.clientX - pan.px) + Math.abs(e.clientY - pan.py) > 5) movedRef.current = true
        if (!movedRef.current) return
        setHover(-1, performance.now())
        el.style.cursor = 'grabbing'
        const s = scaleOf({ view: pan.view, cssW: rect.width, cssH: rect.height })
        viewRef.current = { ...pan.view, x: pan.view.x - (e.clientX - pan.px) / s, y: pan.view.y - (e.clientY - pan.py) / s }
        schedule()
      }}
      onPointerUp={(e) => {
        const wasPanning = panRef.current !== null
        if (wasPanning && movedRef.current) {
          endPan(e.currentTarget)
          onViewChange(viewRef.current)
          return
        }
        const rect = e.currentTarget.getBoundingClientRect()
        const idx = pickNode(nodes, camera(), e.clientX - rect.left, e.clientY - rect.top)
        endPan(e.currentTarget, idx >= 0)
        if (idx >= 0) onOpen(nodes[idx]!.id)
        else onClearSpotlight()
      }}
      onPointerCancel={(e) => {
        const wasPanning = panRef.current !== null
        endPan(e.currentTarget)
        if (wasPanning && movedRef.current) onViewChange(viewRef.current)
      }}
      onPointerLeave={() => {
        if (setHover(-1, performance.now())) schedule()
      }}
      onDoubleClick={() => {
        if (wheelTimerRef.current) {
          clearTimeout(wheelTimerRef.current)
          wheelTimerRef.current = null
        }
        onClearSpotlight()
        onViewChange({ ...FULL_VIEW })
      }}
    >
      <canvas ref={canvasRef} className="sky-surface" />
      {size.w > 0 && size.h > 0 && (
        <div className="tg-ghost" ref={ghostRef}>
          {nodes.map((n) => {
            const p = worldToScreen(cam, n.x, n.y)
            const spot = spotlight?.has(n.id) ?? false
            return (
              <div
                key={n.id}
                data-node-id={n.id}
                aria-label={n.title}
                className={`tg-ghost-node${spotlight ? (spot ? ' spot' : ' faded') : ''}`}
                style={{ left: `${p.x - GHOST / 2}px`, top: `${p.y - GHOST / 2}px` }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
