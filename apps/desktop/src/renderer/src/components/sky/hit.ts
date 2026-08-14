import { VH, VW } from '../../lib/skyLayout.js'

// The single source of truth for "where in the window is this star".
//
// The canvas paints through it, the ghost anchors are positioned through it and
// the picker measures through it — one function, so the thing the eye sees, the
// thing the mouse hits and the thing Playwright clicks can never drift apart.
//
// The camera keeps the SVG viewBox's semantics exactly (a rectangle of virtual
// space, letterboxed into the element with xMidYMid meet), because the topic
// spotlight's fit maths was written against those semantics and the layout it
// frames has not moved.

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

export interface HitNode {
  x: number
  y: number
  hub: boolean
}

// Virtual-space radii, from the SVG that came before: a hub is a bigger star.
export const HUB_R = 11
export const DOT_R = 6
// The pick is generous by four screen pixels — a star is a small target and a
// near miss reads as a miss of the app, not of the hand.
const PICK_PAD = 4
// …and two more for the star already held, so a hand resting on the boundary
// cannot strobe the hover highlight on and off.
const STICKY_PAD = 2

// xMidYMid meet: uniform scale, centred, never cropped.
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

// A distance scan over ≤300 nodes: microseconds per mouse move, and it needs no
// shadow canvas, no quadtree and no second copy of the scene to fall out of
// step. Nearest centre wins; a tie goes to the hub, which is the larger star
// and the one a crowded cluster is named after.
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
