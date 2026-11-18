import { useEffect, useRef } from 'react'
import { RIPPLE_MIN_PX, SMALL_MAX_PX, type OrbId } from '../lib/botAvatar.js'
import { ORB_LOOP_MS, ORB_WAVE_LAYERS, ORB_WORK_LAYERS, orbPaths } from '../lib/orbWave.js'

type OrbMotion = 'static' | 'idle' | 'working'

const STILL = { full: orbPaths('full', 0), small: orbPaths('small', 0) }
const FRAME_MS = 1000 / 30

const live = new Set<Element>()
let mounted = 0
let watcher: IntersectionObserver | undefined
let focus: MutationObserver | undefined
let reduced: MediaQueryList | undefined
let frame = 0
let drawn = -1

function draw(orb: Element, d: string[]): void {
  orb.querySelectorAll('path').forEach((path, i) => path.setAttribute('d', d[i]!))
}

const awake = (): boolean => live.size > 0 && !reduced?.matches && !document.hidden && document.documentElement.dataset['windowFocused'] === 'true'

function tick(now: number): void {
  frame = awake() ? requestAnimationFrame(tick) : 0
  const step = Math.floor(now / FRAME_MS)
  if (step === drawn) return
  drawn = step
  const d = orbPaths('full', ((step * FRAME_MS) % ORB_LOOP_MS) / ORB_LOOP_MS)
  for (const orb of live) draw(orb, d)
}

function sync(): void {
  if (reduced?.matches) for (const orb of live) draw(orb, STILL.full)
  if (!awake()) {
    cancelAnimationFrame(frame)
    frame = 0
  } else if (frame === 0) frame = requestAnimationFrame(tick)
}

export function ripple(orb: Element): () => void {
  if (!watcher) {
    watcher = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) live.add(entry.target)
        else live.delete(entry.target)
      }
      sync()
    })
    focus = new MutationObserver(sync)
    focus.observe(document.documentElement, { attributes: true, attributeFilter: ['data-window-focused'] })
    document.addEventListener('visibilitychange', sync)
    reduced = matchMedia('(prefers-reduced-motion: reduce)')
    reduced.addEventListener('change', sync)
  }
  watcher.observe(orb)
  mounted++
  return () => {
    watcher?.unobserve(orb)
    live.delete(orb)
    draw(orb, STILL[orb.getAttribute('data-master') === 'small' ? 'small' : 'full'])
    if (--mounted === 0) {
      watcher?.disconnect()
      focus?.disconnect()
      document.removeEventListener('visibilitychange', sync)
      reduced?.removeEventListener('change', sync)
      watcher = focus = reduced = undefined
    }
    sync()
  }
}

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
