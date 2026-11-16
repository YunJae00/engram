import { useEffect, useRef } from 'react'
import { RIPPLE_MIN_PX, SMALL_MAX_PX, type OrbId } from '../lib/botAvatar.js'
import { ORB_LOOP_MS, ORB_WAVE_LAYERS, ORB_WORK_LAYERS, orbPaths } from '../lib/orbWave.js'

export type OrbMotion = 'static' | 'idle' | 'working'

// S1 Glass: a dark glass ball with a silver rim, mist lit from below, and one S-shaped wave of light across the middle.
// bot-orb.css paints the ball, the mist and the rim; the two svgs here hold the wave and its working overlay (see lib/orbWave.ts).
// Under 64px nothing is painted per frame: css breathes the light layer. From 64px one shared ticker redraws the wave so the ripple travels.
const STILL = { full: orbPaths('full', 0), small: orbPaths('small', 0) }
const FRAME_MS = 1000 / 30

const live = new Set<Element>()
let watcher: IntersectionObserver | undefined
let frame = 0
let drawn = -1

function draw(orb: Element, d: string[]): void {
  orb.querySelectorAll('path').forEach((path, i) => path.setAttribute('d', d[i]!))
}

// One requestAnimationFrame loop for every rippling orb on screen. It stops when none is on screen, the browser stops it while the document is hidden,
// and it draws nothing while the window is not focused. Reduced motion holds the still frame.
function tick(now: number): void {
  frame = live.size > 0 ? requestAnimationFrame(tick) : 0
  if (document.documentElement.dataset['windowFocused'] !== 'true') return
  const step = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : Math.floor(now / FRAME_MS) + 1
  if (step === drawn) return
  drawn = step
  const d = step === 0 ? STILL.full : orbPaths('full', ((step * FRAME_MS) % ORB_LOOP_MS) / ORB_LOOP_MS)
  for (const orb of live) draw(orb, d)
}

function ripple(orb: Element): () => void {
  watcher ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) live.add(entry.target)
      else live.delete(entry.target)
    }
    if (live.size > 0 && frame === 0) frame = requestAnimationFrame(tick)
  })
  watcher.observe(orb)
  return () => {
    watcher!.unobserve(orb)
    live.delete(orb)
    draw(orb, STILL.full)
  }
}

// size is the drawn width in css pixels; without it the orb is the small static master.
export function BotOrb({ orb, motion, size = SMALL_MAX_PX }: { orb: OrbId; motion: OrbMotion; size?: number }) {
  const master = size <= SMALL_MAX_PX ? 'small' : 'full'
  const rippling = motion !== 'static' && size >= RIPPLE_MIN_PX
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => (rippling && box.current ? ripple(box.current) : undefined), [rippling])
  const d = STILL[master]
  return (
    <span ref={box} className="bot-orb" data-orb={orb} data-motion={motion} data-master={master} data-ripple={rippling ? 'true' : undefined}>
      <span className="bot-orb-light">
        <svg className="bot-orb-wave" viewBox="0 0 100 100" focusable="false">
          {ORB_WAVE_LAYERS.map((name, i) => <path key={name} className={`bot-orb-${name}`} d={d[i]} />)}
        </svg>
        <svg className="bot-orb-work" viewBox="0 0 100 100" focusable="false">
          {ORB_WORK_LAYERS.map((name, i) => <path key={name} className={`bot-orb-${name}`} d={d[ORB_WAVE_LAYERS.length + i]} />)}
        </svg>
      </span>
    </span>
  )
}
