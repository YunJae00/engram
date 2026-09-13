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
  const [awake, setAwake] = useState(false)
  // Counts presses; the mark remounts on each so its pulse plays once.
  const [presses, setPresses] = useState(0)
  const restTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    // The broadcast may have landed before this mounted; ask once.
    let stale = false
    void api.desktopOverlayStatus().then((current) => { if (!stale) setStatus(current) }).catch((error: unknown) => console.error('control overlay status', error))
    const off = api.onEvent((event) => {
      if (event.type === 'desktop:control') {
        stale = true
        setStatus(event.control)
        if (event.control.state !== 'running') setPointer(null)
        return
      }
      if (event.type !== 'desktop:pointer') return
      const point = { x: event.x, y: event.y }
      setPointer(point)
      setAwake(true)
      if (event.press) setPresses((count) => count + 1)
      window.clearTimeout(restTimer.current)
      restTimer.current = window.setTimeout(() => setAwake(false), COMPANION_REST_MS)
    })
    return () => {
      stale = true
      off()
      window.clearTimeout(restTimer.current)
    }
  }, [])

  const mode = modeOf(status)
  const lastApplication = useRef(status.application)
  if (mode !== 'off') lastApplication.current = status.application
  const application = mode === 'off' ? lastApplication.current : status.application
  const companion = mode === 'running' && pointer !== null && !status.application
  const appBounds = application?.bounds
  return (
    <div className="control-overlay" data-testid="control-overlay" data-state={mode} data-scope={application ? 'application' : 'desktop'} data-engine={status.engine ?? 'default'}>
      <div className="control-overlay-glow" data-visible={mode !== 'off' && !application?.nativeFrame && (!application || application.visible)} style={appBounds ? { inset: 'auto', left: 0, top: 0, transform: `translate(${appBounds.x}px, ${appBounds.y}px)`, width: appBounds.width, height: appBounds.height, borderRadius: 8 } : undefined} />
      {companion && (
        <div className="control-overlay-cursor" data-awake={awake ? 'true' : 'false'}>
          <span className="control-overlay-mark" style={place(pointer)}>
            <span key={presses} data-pressed={presses > 0 ? 'true' : undefined}><Comet size={22} /></span>
          </span>
        </div>
      )}
    </div>
  )
}
