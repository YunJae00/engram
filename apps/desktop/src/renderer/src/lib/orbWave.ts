// The S1 Glass wave: one S-shaped line of light across a glass ball, as svg path data in a 100-unit box (ball radius 50).
// Every layer is a ribbon around the same line: it is widest where the light is strongest and tapers to nothing at the glass,
// so a blur alone gives the falloff and no gradient is needed.
export type OrbMaster = 'full' | 'small'

export const ORB_LOOP_MS = 12000
// In order: the dark upper half, the warm and cool haze, the warm and cool fringe, the white core; then the working overlay: wider haze and a thicker core.
export const ORB_WAVE_LAYERS = ['shade', 'warm-haze', 'cool-haze', 'warm', 'cool', 'core'] as const
export const ORB_WORK_LAYERS = ['work-warm', 'work-cool', 'work-core'] as const

const TAU = Math.PI * 2
const STEPS = 40
const bell = (x: number, w: number) => Math.exp(-(x * x) / (w * w))
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const at = (v: number) => (50 + 50 * v).toFixed(2)

// t is the loop position 0..1. Every term is periodic in t, so t = 1 draws the same line as t = 0.
// The small master (32px and under) is a taller, plainer S: no hooks at the glass and half the ripple.
function line(small: boolean, t: number): (x: number) => number {
  const amp = (small ? 0.17 : 0.13) * (1 + 0.1 * Math.sin(TAU * t)), drift = 0.04 * Math.sin(TAU * t + 1)
  const ripple = small ? 0.01 : 0.02, hook = small ? 0 : 1
  return x => 0.035 + amp * (0.77 * Math.tanh(3.5 * (x + 0.03 + drift)) + 0.31 * Math.sin(Math.PI * x / 0.8))
    + ripple * Math.sin(TAU * (1.1 * x - t)) + 0.66 * ripple * Math.sin(TAU * (1.9 * x + t) + 1)
    + hook * (0.25 * smooth(0.5, 1, x) ** 2 - 0.32 * smooth(0.55, 1, -x) ** 2)
}

export function orbPaths(master: OrbMaster, t: number): string[] {
  const small = master === 'small', wave = line(small, t)
  const shade: string[] = []
  const ribbons = Array.from({ length: 8 }, () => ({ top: [] as string[], bottom: [] as string[] }))
  for (let i = 0; i <= STEPS; i++) {
    const x = -1.04 + (2.08 * i) / STEPS, y = wave(x)
    // A distance d across the line is d * k down the page.
    const k = Math.hypot(1, (wave(x + 0.01) - wave(x - 0.01)) / 0.02)
    const env = small ? 0.4 + 0.6 * bell(x, 0.75) : 0.06 + 0.94 * bell(x - 0.02, 0.48)
    const busy = small ? env : 0.06 + 0.94 * bell(x - 0.02, 0.56)
    const w = (small ? 0.1 : 0.038) * (0.35 + 0.65 * env ** 0.6)
    const left = small ? env : 0.1 + 0.9 * bell(x + 0.15, 0.5)
    // The core is white only where the light saturates, so it ends before the glass and the fringes run on alone.
    const core = (gain: number, e: number) => Math.sqrt(Math.max(0, Math.log((gain * e) / 0.45)))
    const bands: [number, number][] = [
      [-0.05 * env, 0.05 * env], [0.06 * env, 0.06 * env],
      [-1.6 * w, w * Math.sqrt(env)], [1.7 * w, 1.1 * w * Math.sqrt(left)],
      [0, 1.25 * w * core(1.6, env)],
      [-0.075 * busy, 0.075 * busy], [0.085 * busy, 0.085 * busy], [0, (small ? 1.45 : 1.72) * w * core(2.24, busy)],
    ]
    shade.push(`${at(x)} ${at(y + 0.5 * w * k)}`)
    bands.forEach(([centre, half], n) => {
      ribbons[n]!.top.push(`${at(x)} ${at(y + (centre - half) * k)}`)
      ribbons[n]!.bottom.push(`${at(x)} ${at(y + (centre + half) * k)}`)
    })
  }
  return [`M-10 -10L${shade.join('L')}L110 -10Z`, ...ribbons.map(r => `M${r.top.join('L')}L${r.bottom.reverse().join('L')}Z`)]
}
