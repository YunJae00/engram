import { VW } from '../../lib/skyLayout.js'
import { EASE, EASE_OUT, run } from './anim.js'
import { DOT_R, HUB_R, scaleOf, worldToScreen, type Camera } from './hit.js'

export interface SkyNode {
  id: string
  title: string
  hub: boolean
  tone: 'green' | 'amber' | 'red' | null
  activation: number
  ignite: boolean
  recalled: boolean
  x: number
  y: number
}

export interface Palette {
  fg: string
  fgDim: string
  fgFaint: string
  accentSoft: string
  accentLine: string
  gild: string
  clay: string
  cardTop: string
  panelBg: string
  font: string
}

interface Scene {
  nodes: readonly SkyNode[]
  edges: readonly (readonly [number, number])[]
  fabric?: readonly (readonly [number, number])[]
  cam: Camera
  palette: Palette
  now: number
  first: ReadonlyMap<string, number>
  ignited: ReadonlyMap<string, number>
  spot: ReadonlySet<string> | null
  spotFrom: ReadonlySet<string> | null
  spotSince: number
  hover: { id: string | null; prevId: string | null; since: number }
  emphasis: {
    ids: ReadonlySet<string> | null
    from: ReadonlyMap<string, number>
    since: number
    now: Map<string, number>
  }
  labels: { small: boolean; rank: readonly number[]; limit: number }
  reduced: boolean
}

const ENTER_MS = 320
const ENTER_STEP_MS = 40
const ENTER_SLOTS = 24
const IGNITE_MS = 2400
const PULSE_MS = 3200
const PULSE_RUNS = 3
const HOVER_MS = 140
const SPOT_MS = 480
const EMPH_MS = 200
const FADED_ALPHA = 0.12
const DIM_ALPHA = 0.2
const EDGE_ALPHA = 0.45
const LABEL_PX = 11
const LABEL_CHARS = 14

export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    fg: v('--fg', '#2b2b33'),
    fgDim: v('--fg-dim', '#585a66'),
    fgFaint: v('--fg-faint', '#888b98'),
    accentSoft: v('--accent-soft', '#ecedf1'),
    accentLine: v('--accent-line', '#c8cad2'),
    gild: v('--gild', '#a9832f'),
    clay: v('--clay', '#b0603b'),
    cardTop: v('--card-top', '#ffffff'),
    panelBg: v('--panel-bg', '#eef0f4'),
    font: v('--font', 'system-ui, sans-serif'),
  }
}

function starAlpha(node: SkyNode): number {
  return 0.3 + 0.7 * Math.min(1, Math.max(0, node.activation))
}

function toneStroke(tone: SkyNode['tone'], p: Palette): string {
  if (tone === 'amber') return '#d99a2b'
  if (tone === 'red') return p.clay
  return p.fgDim
}

function labelRamp(cam: Camera): number {
  return Math.min(Math.max((zoomFactor(cam) - 1) / 0.8, 0), 1)
}

export function zoomFactor(cam: Camera): number {
  return VW / cam.view.w
}

const TIER_OPEN = [1.25, 1.85]
const TIER_CLOSE = [1.15, 1.75]
const TIER_LIMITS = [0, 20, Infinity]

export function labelBudget(k: number, tier: number, members: number): { tier: number; limit: number } {
  let next = Math.max(tier, 0)
  for (;;) {
    if (next < TIER_OPEN.length && k >= TIER_OPEN[next]!) next++
    else if (next > 0 && k < TIER_CLOSE[next - 1]!) next--
    else break
  }
  const limit = TIER_LIMITS[next]!
  return { tier: next, limit: limit === Infinity ? members : limit }
}

export function drawSky(ctx: CanvasRenderingContext2D, scene: Scene): boolean {
  const { nodes, cam, palette, now, reduced } = scene
  const s = scaleOf(cam)
  let live = false

  ctx.clearRect(0, 0, cam.cssW, cam.cssH)

  const px: number[] = new Array(nodes.length)
  const py: number[] = new Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const p = worldToScreen(cam, nodes[i]!.x, nodes[i]!.y)
    px[i] = p.x
    py[i] = p.y
  }

  const emphP = reduced ? 1 : run(now, scene.emphasis.since, EMPH_MS).p
  if (emphP < 1) live = true
  const emph: number[] = new Array(nodes.length)
  const ids = scene.emphasis.ids
  let quiet = true
  for (let i = 0; i < nodes.length; i++) {
    const id = nodes[i]!.id
    const to = ids ? (ids.has(id) ? 1 : DIM_ALPHA) : 1
    const value = scene.emphasis.from.get(id) ?? 1
    emph[i] = value + (to - value) * EASE(emphP)
    if (emph[i] !== 1) quiet = false
    scene.emphasis.now.set(id, emph[i]!)
  }

  const spotP = scene.spot === scene.spotFrom ? 1 : reduced ? 1 : run(now, scene.spotSince, SPOT_MS).p
  if (spotP < 1) live = true
  const alpha: number[] = new Array(nodes.length)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const to = scene.spot ? (scene.spot.has(n.id) ? 1 : FADED_ALPHA) : 1
    const from = scene.spotFrom ? (scene.spotFrom.has(n.id) ? 1 : FADED_ALPHA) : 1
    let a = (from + (to - from) * EASE(spotP)) * emph[i]!
    const born = scene.first.get(n.id)
    if (!reduced && born !== undefined) {
      const enter = run(now, born, ENTER_MS, (i % ENTER_SLOTS) * ENTER_STEP_MS)
      if (enter.live) live = true
      a *= EASE_OUT(enter.p)
    }
    alpha[i] = a
  }

  const hoverAmount = (i: number): number => {
    const id = nodes[i]!.id
    if (reduced) return id === scene.hover.id ? 1 : 0
    if (id !== scene.hover.id && id !== scene.hover.prevId) return 0
    const h = run(now, scene.hover.since, HOVER_MS)
    if (h.live) live = true
    const e = EASE(h.p)
    return id === scene.hover.id ? e : 1 - e
  }

  const strings = (
    list: readonly (readonly [number, number])[],
    alphaScale: number,
    dash: readonly [number, number],
  ) => {
    if (list.length === 0) return
    const buckets = new Map<number, number[]>()
    if (quiet) buckets.set(1, list.map((_, e) => e))
    else {
      for (let e = 0; e < list.length; e++) {
        const [a, b] = list[e]!
        if (px[a] === undefined || px[b] === undefined) continue
        const key = Math.round(Math.min(emph[a]!, emph[b]!) * 100) / 100
        const bucket = buckets.get(key)
        if (bucket) bucket.push(e)
        else buckets.set(key, [e])
      }
    }
    ctx.save()
    ctx.strokeStyle = palette.fgFaint
    ctx.lineWidth = s
    ctx.setLineDash([dash[0] * s, dash[1] * s])
    for (const [strength, bucket] of buckets) {
      ctx.globalAlpha = EDGE_ALPHA * alphaScale * strength
      ctx.beginPath()
      for (const e of bucket) {
        const [a, b] = list[e]!
        if (px[a] === undefined || px[b] === undefined) continue
        ctx.moveTo(px[a]!, py[a]!)
        ctx.lineTo(px[b]!, py[b]!)
      }
      ctx.stroke()
    }
    ctx.restore()
  }
  strings(scene.fabric ?? [], 0.45, [1.5, 6])
  strings(scene.edges, 1, [3, 4])

  if (!reduced) {
    ctx.save()
    ctx.strokeStyle = palette.accentLine
    ctx.lineWidth = s
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      if (!n.hub) continue
      const born = scene.first.get(n.id)
      if (born === undefined) continue
      const total = run(now, born, PULSE_MS * PULSE_RUNS)
      if (!total.live) continue
      live = true
      const cycle = ((now - born) % PULSE_MS) / PULSE_MS
      if (cycle >= 0.7) continue
      const e = EASE_OUT(cycle / 0.7)
      const a = alpha[i]! * 0.5 * (1 - e)
      if (a < 0.004) continue
      ctx.globalAlpha = a
      ctx.beginPath()
      ctx.arc(px[i]!, py[i]!, 13 * s * (1 + 0.9 * e), 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }

  ctx.save()
  ctx.strokeStyle = palette.gild
  ctx.lineWidth = 1.2 * s
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const spot = scene.spot?.has(n.id) ?? false
    if (!n.recalled && !spot) continue
    const a = alpha[i]! * (spot ? 0.9 : 0.55)
    if (a < 0.004) continue
    ctx.globalAlpha = a
    ctx.beginPath()
    ctx.arc(px[i]!, py[i]!, (n.hub ? 16 : 11) * s, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()

  ctx.save()
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const spot = scene.spot?.has(n.id) ?? false
    const a = alpha[i]! * (spot ? 1 : starAlpha(n))
    if (a < 0.004) continue
    const r = (n.hub ? HUB_R : DOT_R) * s * (1 + 0.35 * hoverAmount(i))
    ctx.globalAlpha = a
    ctx.beginPath()
    ctx.arc(px[i]!, py[i]!, r, 0, Math.PI * 2)
    ctx.fillStyle = n.hub ? palette.accentSoft : palette.cardTop
    ctx.fill()
    ctx.lineWidth = (n.hub ? 1.8 : 1.4) * s
    ctx.strokeStyle = n.hub ? palette.accentLine : toneStroke(n.tone, palette)
    ctx.stroke()
    const lit = reduced ? undefined : scene.ignited.get(n.id)
    if (lit === undefined) continue
    const flash = run(now, lit, IGNITE_MS)
    if (!flash.live) continue
    live = true
    const heat = 1 - EASE_OUT(flash.p)
    ctx.globalAlpha = a * heat
    ctx.strokeStyle = palette.gild
    ctx.shadowColor = palette.gild
    ctx.shadowBlur = 10 * s * heat
    ctx.stroke()
    ctx.shadowBlur = 0
  }
  ctx.restore()

  const ramp = labelRamp(cam)
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `${LABEL_PX}px ${palette.font}`
  ctx.lineJoin = 'round'
  ctx.strokeStyle = palette.panelBg
  ctx.lineWidth = 3
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const hot = hoverAmount(i)
    const inBudget = Math.min(Math.max(scene.labels.limit - (scene.labels.rank[i] ?? Infinity), 0), 1)
    const always = n.hub || scene.labels.small || (scene.spot?.has(n.id) ?? false)
    const base = always ? 1 : ramp * inBudget
    const a = alpha[i]! * Math.max(base, hot)
    if (a < 0.004) continue
    const text = hot > 0.5 ? n.title : n.title.length > LABEL_CHARS ? `${n.title.slice(0, LABEL_CHARS)}…` : n.title
    ctx.globalAlpha = a
    ctx.fillStyle = hot > 0 ? palette.fg : palette.fgFaint
    const y = py[i]! + (n.hub ? HUB_R : DOT_R) * s + 13
    ctx.strokeText(text, px[i]!, y)
    ctx.fillText(text, px[i]!, y)
  }
  ctx.restore()

  return live
}
