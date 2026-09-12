import { useEffect, useSyncExternalStore } from 'react'
import type { DesktopControlStatusDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { Comet } from '../components/Icon.js'

// The small window at the top of the display that holds the controlled app:
// who is moving the mouse, how to take it back, and Stop. Its window never
// activates, so a click here cannot pull the foreground off that app.

// The window is transparent: the boot word and the app ground must not be
// painted over the person's screen before React's first frame.
if (typeof document !== 'undefined') {
  document.getElementById('boot')?.remove()
  document.body.classList.add('control-host')
}

// The status lives outside React so the first frame can already carry it,
// and so a status event that lands while the initial query is still in
// flight is not overwritten by that older answer.
let current: DesktopControlStatusDto = { state: 'idle' }
let generation = 0
const listeners = new Set<() => void>()

function commit(next: DesktopControlStatusDto): void {
  current = next
  generation += 1
  for (const listener of listeners) listener()
}

export function primeControlStatus(): Promise<void> {
  const seen = generation
  return api.desktopOverlayStatus().then(
    (status) => {
      if (generation === seen) commit(status)
    },
    (error: unknown) => console.error('control pill status', error),
  )
}

export function watchControlStatus(listener: () => void): () => void {
  listeners.add(listener)
  const off = api.onEvent((event) => {
    if (event.type === 'desktop:control') commit(event.control)
  })
  return () => {
    listeners.delete(listener)
    off()
  }
}

function snapshot(): DesktopControlStatusDto {
  return current
}

export function ControlPill() {
  const status = useSyncExternalStore(watchControlStatus, snapshot, snapshot)
  useEffect(() => {
    void primeControlStatus()
  }, [])

  const running = status.state === 'running'
  const paused = status.state === 'paused' && status.resumable === true
  if (!running && !paused) return null
  const who = status.engineLabel ?? 'Engram'
  return (
    <div className="control-pill-stage">
      <div className="control-pill" data-testid="control-pill" data-state={running ? 'running' : 'paused'} data-engine={status.engine ?? 'default'}>
        <span className="control-pill-mark">
          <Comet size={20} />
        </span>
        <div className="control-pill-copy">
          {running ? (
            <>
              <strong>{status.application ? `Working in ${status.application.name}` : `${who} is controlling your computer`}</strong>
              <span>{status.application ? 'Your mouse and keyboard stay yours · Esc to stop' : `${status.inputActive === false ? 'Planning next action · ' : ''}Esc to take over`}</span>
            </>
          ) : (
            <>
              <strong>You took over</strong>
              <span>{who} continues when your hands are still</span>
            </>
          )}
        </div>
        {paused && (
          <button type="button" className="control-pill-resume" data-testid="overlay-resume" onClick={() => void api.desktopControlResume()}>
            Resume now
          </button>
        )}
        <button type="button" className="control-pill-stop" data-testid="overlay-stop" onClick={() => void api.desktopControlStop()}>
          Stop
        </button>
      </div>
    </div>
  )
}
