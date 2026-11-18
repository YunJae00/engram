import { VH, VW } from '../../lib/skyLayout.js'

export interface View {
  x: number
  y: number
  w: number
  h: number
}

export const FULL_VIEW: View = { x: 0, y: 0, w: VW, h: VH }

export interface Camera {
  view: View
  cssW: number
  cssH: number
}

interface HitNode {
  x: number
  y: number
  hub: boolean
}

export const HUB_R = 11
export const DOT_R = 6
const PICK_PAD = 4
const STICKY_PAD = 2

export function scaleOf(cam: Camera): number {
  return Math.min(cam.cssW / cam.view.w, cam.cssH / cam.view.h)
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  const s = scaleOf(cam)
  return {
    x: (cam.cssW - cam.view.w * s) / 2 + (wx - cam.view.x) * s,
    y: (cam.cssH - cam.view.h * s) / 2 + (wy - cam.view.y) * s,
  }
}

export function screenToWorld(cam: Camera, px: number, py: number): { x: number; y: number } {
  const s = scaleOf(cam)
  return {
    x: cam.view.x + (px - (cam.cssW - cam.view.w * s) / 2) / s,
    y: cam.view.y + (py - (cam.cssH - cam.view.h * s) / 2) / s,
  }
}

export function pickNode(nodes: readonly HitNode[], cam: Camera, px: number, py: number, sticky = -1): number {
  const s = scaleOf(cam)
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!
    const p = worldToScreen(cam, n.x, n.y)
    const dist = Math.hypot(p.x - px, p.y - py)
    if (dist > (n.hub ? HUB_R : DOT_R) * s + PICK_PAD + (i === sticky ? STICKY_PAD : 0)) continue
    if (dist < bestDist - 0.5) {
      best = i
      bestDist = dist
    } else if (dist < bestDist + 0.5 && n.hub && best >= 0 && !nodes[best]!.hub) {
      best = i
      bestDist = Math.min(bestDist, dist)
    }
  }
  return best
}
