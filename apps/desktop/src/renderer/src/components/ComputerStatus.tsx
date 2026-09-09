import { Pause, ShieldCheck, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DesktopControlStatusDto } from '../../../shared/desktop.js'
import { desktopError, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'

// Live control belongs on the desktop overlay. Keep terminal errors in the
// app so the reason remains readable after the control windows disappear.
export function computerStateLabel(control: DesktopControlStatusDto): string {
  const who = control.engineLabel ?? 'The comet'
  if (control.state === 'running') return `${who} is controlling your computer`
  if (control.state === 'ready') return `${who} is about to use your computer`
  if (control.state === 'needs-person') return 'Your attention is needed'
  return control.resumable ? 'You took over' : 'Computer control is off'
}

export function computerStateDetail(control: DesktopControlStatusDto): string {
  const who = control.engineLabel ?? 'The comet'
  if (control.state === 'running') return `Using your mouse and keyboard${control.name ? ` · ${control.name}` : ''} · Esc to take over`
  if (control.state === 'ready') return 'Your mouse and keyboard stay yours until it starts.'
  if (control.state === 'needs-person') return control.reason || 'Check the request, or stop to cancel it.'
  return control.resumable ? `${who} continues once your hands have been still for a moment.` : control.reason || 'Send the next task when you are ready.'
}

export function ComputerStatus() {
  const { control, error: statusError } = useDesktopSession()
  const [error, setError] = useState('')
  const active = Boolean(control && control.state !== 'idle')
  const stop = () => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }
  useEffect(() => {
    if (!active || (control?.state === 'paused' && !control.resumable)) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause)))
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [active, control?.state, control?.resumable])
  if (!active || !control) return null
  if (control.state === 'running' || control.state === 'ready' || (control.state === 'paused' && control.resumable)) return null
  const Icon = control.state === 'needs-person' ? ShieldCheck : Pause
  const dismiss = control.state === 'paused' && !control.resumable
  return <section className="computer-status" data-state={control.state} data-resumable={control.resumable === true ? 'true' : undefined} data-testid="computer-control-status" aria-label="Computer control">
    <Icon size={16} aria-hidden />
    <div className="computer-status-copy" role="status">
      <strong>{computerStateLabel(control)}</strong>
      <span>{error || statusError || computerStateDetail(control)}</span>
    </div>
    <button className="computer-stop" data-testid="computer-control-stop" onClick={stop}>{dismiss ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}<span>{dismiss ? 'Dismiss' : 'Stop'}</span>{!dismiss && <kbd>Esc</kbd>}</button>
  </section>
}
