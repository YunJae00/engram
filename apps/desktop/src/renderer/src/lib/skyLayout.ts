import type { NoteDto } from '../../../shared/types.js'

export const VW = 1200
export const VH = 800

const NODE_CAP = 150

interface SolvedSky {
  pos: { x: number; y: number }[]
  edges: [number, number][]
  neighbors: number[][]
  order: number[]
}

function buildAdjacency(count: number, edges: readonly (readonly [number, number])[]): number[][] {
  const neighbors: number[][] = Array.from({ length: count }, () => [])
  for (const [s, t] of edges) {
    neighbors[s]!.push(t)
    neighbors[t]!.push(s)
  }
  return neighbors
}

function byDegree(neighbors: readonly number[][]): number[] {
  return neighbors.map((_, i) => i).sort((a, b) => neighbors[b]!.length - neighbors[a]!.length || a - b)
}

interface SkyProbe {
  frames: number
  solves: number
}

export function skyProbe(): SkyProbe {
  const host = globalThis as unknown as { __engramSky?: SkyProbe }
  if (!host.__engramSky) host.__engramSky = { frames: 0, solves: 0 }
  return host.__engramSky
}

function hashOf(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}

export function pickStars(notes: NoteDto[]): NoteDto[] {
  return [...notes].sort((a, b) => Number(b.type === 'hub') - Number(a.type === 'hub')).slice(0, NODE_CAP)
}

export function shapeDigest(picked: NoteDto[]): string {
  const ids = picked.map((n) => (n.type === 'hub' ? `${n.id}*` : n.id)).join('|')
  const rels = picked.map((n) => n.derived_from.join(',')).join(';')
  return `${ids}‖${rels}`
}

export function solvePositions(picked: NoteDto[]): SolvedSky {
  skyProbe().solves++
  const index = new Map(picked.map((n, i) => [n.id, i]))
  const edges: [number, number][] = []
  for (const n of picked) {
    for (const rel of n.derived_from) {
      const j = index.get(rel)
      if (j !== undefined) edges.push([index.get(n.id)!, j])
    }
  }

  const neighbors = buildAdjacency(picked.length, edges)

  const pos = picked.map((n) => {
    const angle = ((hashOf(n.id) % 360) * Math.PI) / 180
    const r = 0.18 * VH + (hashOf(n.id) % Math.round(0.22 * VH))
    return { x: VW / 2 + Math.cos(angle) * r, y: VH / 2 + Math.sin(angle) * r }
  })

  const rest = Math.max(70, VH / 8)
  for (let iter = 0; iter < 260; iter++) {
    for (let i = 0; i < pos.length; i++) {
      const a = pos[i]!
      let fx = (VW / 2 - a.x) * 0.008
      let fy = (VH / 2 - a.y) * 0.008
      for (let j = 0; j < pos.length; j++) {
        if (i === j) continue
        const b = pos[j]!
        const dx = a.x - b.x
        const dy = a.y - b.y
        const d2 = Math.max(dx * dx + dy * dy, 100)
        const rep = 3200 / d2
        fx += (dx / Math.sqrt(d2)) * rep
        fy += (dy / Math.sqrt(d2)) * rep
      }
      for (const j of neighbors[i]!) {
        const other = pos[j]!
        const dx = other.x - a.x
        const dy = other.y - a.y
        const d = Math.max(Math.hypot(dx, dy), 1)
        const pull = (d - rest) * 0.02
        fx += (dx / d) * pull
        fy += (dy / d) * pull
      }
      a.x = Math.min(Math.max(a.x + fx, 30), VW - 30)
      a.y = Math.min(Math.max(a.y + fy, 30), VH - 38)
    }
  }
  return { pos, edges, neighbors, order: byDegree(neighbors) }
}
