
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 6; i++) {
      const err = sampleX(t) - x
      if (Math.abs(err) < 1e-5) break
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t -= err / d
    }
    return ((ay * t + by) * t + cy) * t
  }
}

/** The two CSS timing functions the sky inherited, kept to the letter. */
export const EASE = cubicBezier(0.25, 0.1, 0.25, 1)
export const EASE_OUT = cubicBezier(0, 0, 0.58, 1)

/** A keyframed run: fixed start, fixed duration, optional delay. */
export interface Run {
  p: number
  live: boolean
}

export function run(now: number, start: number, duration: number, delay = 0): Run {
  const t = now - start - delay
  if (t <= 0) return { p: 0, live: true }
  if (t >= duration) return { p: 1, live: false }
  return { p: t / duration, live: true }
}

/**
 * A scalar that travels to a target over a fixed span and then STOPS.
 *
 * Interrupts start a replacement tween from the value the eye is currently
 * looking at, never from the old origin — hover in, hover out halfway, hover
 * back in, and the star never jumps. Retargeting to where it is already going
 * is a no-op, so a repeated request cannot restart the clock and keep the
 * scheduler awake.
 */
export class Tween {
  private from: number
  private target: number
  private start = -1e9
  private ms = 1

  constructor(initial: number, private readonly ease: (x: number) => number = EASE) {
    this.from = initial
    this.target = initial
  }

  to(target: number, now: number, ms: number): void {
    if (target === this.target) return
    this.from = this.value(now)
    this.target = target
    this.start = now
    this.ms = Math.max(ms, 1)
  }

  /** Jump with no motion — the reduced-motion path, and first paint. */
  set(target: number): void {
    this.from = target
    this.target = target
    this.start = -1e9
  }

  value(now: number): number {
    const t = now - this.start
    if (t >= this.ms) return this.target
    if (t <= 0) return this.from
    return this.from + (this.target - this.from) * this.ease(t / this.ms)
  }

  live(now: number): boolean {
    return now - this.start < this.ms
  }
}
