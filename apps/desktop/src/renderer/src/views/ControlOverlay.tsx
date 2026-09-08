import { useEffect, useRef, useState } from 'react'
import type { DesktopControlStatusDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { Comet } from '../components/Icon.js'

// One see-through window per display: a glow along the screen edges while a
// comet has the computer, and the comet mark riding beside the pointer. No
// words here — the pill on the pointer's display carries those.

const COMPANION_DX = 14
const COMPANION_DY = 12
const COMPANION_REST_MS = 1800
const TRAIL_SETTLE_MS = 160
const TRAIL_LENGTH = 2

interface Point { x: number; y: number }
type Mode = 'running' | 'paused' | 'off'

// The window is transparent: the boot word and the app ground must not be
// painted over the person's screen before React's first frame.
if (typeof document !== 'undefined') {
  document.getElementById('boot')?.remove()
  document.body.classList.add('control-host')
}

function modeOf(status: DesktopControlStatusDto): Mode {
  if (status.state === 'running') return 'running'
  if (status.state === 'paused' && status.resumable) return 'paused'
  return 'off'
}

function place(point: Point): { transform: string } {
  return { transform: `translate(${point.x + COMPANION_DX}px, ${point.y + COMPANION_DY}px)` }
}

export function ControlOverlay() {
  const [status, setStatus] = useState<DesktopControlStatusDto>({ state: 'idle' })
  const [pointer, setPointer] = useState<Point | null>(null)
  // Where the pointer just was, newest first: the ghost copies sit there.
  const [trail, setTrail] = useState<Point[]>([])
  const [awake, setAwake] = useState(false)
  // Counts presses; the mark remounts on each so its pulse plays once.
  const [presses, setPresses] = useState(0)
  const restTimer = useRef<number | undefined>(undefined)
  const trailTimer = useRef<number | undefined>(undefined)
  const lastPointer = useRef<Point | null>(null)

  useEffect(() => {
    // The broadcast may have landed before this mounted; ask once.
    let stale = false
    void api.desktopOverlayStatus().then((current) => { if (!stale) setStatus(current) }).catch((error: unknown) => console.error('control overlay status', error))
    const off = api.onEvent((event) => {
      if (event.type === 'desktop:control') {
        stale = true
        setStatus(event.control)
        return
      }
      if (event.type !== 'desktop:pointer') return
      const point = { x: event.x, y: event.y }
      const previous = lastPointer.current
      lastPointer.current = point
      setPointer(point)
      if (previous && (previous.x !== point.x || previous.y !== point.y)) setTrail((older) => [previous, ...older].slice(0, TRAIL_LENGTH))
      setAwake(true)
      if (event.press) setPresses((count) => count + 1)
      window.clearTimeout(restTimer.current)
      restTimer.current = window.setTimeout(() => setAwake(false), COMPANION_REST_MS)
      window.clearTimeout(trailTimer.current)
      trailTimer.current = window.setTimeout(() => setTrail([]), TRAIL_SETTLE_MS)
    })
    return () => {
      stale = true
      off()
      window.clearTimeout(restTimer.current)
      window.clearTimeout(trailTimer.current)
    }
  }, [])

  const mode = modeOf(status)
  const companion = mode === 'running' && pointer !== null
  return (
    <div className="control-overlay" data-testid="control-overlay" data-state={mode} data-engine={status.engine ?? 'default'}>
      {mode !== 'off' && <div className="control-overlay-glow" />}
      {companion && (
        <div className="control-overlay-cursor" data-awake={awake ? 'true' : 'false'}>
          {Array.from({ length: TRAIL_LENGTH }, (_, index) => {
            const ghost = trail[index]
            return (
              <span key={index} className="control-overlay-ghost" data-order={ghost ? index + 1 : undefined} style={place(ghost ?? pointer)}>
                <Comet size={22} />
              </span>
            )
          })}
          <span key={presses} className="control-overlay-mark" data-pressed={presses > 0 ? 'true' : undefined} style={place(pointer)}>
            <Comet size={22} />
          </span>
        </div>
      )}
    </div>
  )
}
