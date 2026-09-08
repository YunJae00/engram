import { Monitor, Pause, ShieldCheck, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { desktopError, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'

export function computerStateLabel(state: string): string {
  return state === 'ready' ? 'Ready for your next task' : state === 'running' ? 'Computer control is on' : state === 'needs-person' ? 'Your attention is needed' : 'Computer control is paused'
}

export function ComputerStatus() {
  const { control, error: statusError } = useDesktopSession()
  const [error, setError] = useState('')
  const active = Boolean(control && control.state !== 'idle')
  const stop = () => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }
  useEffect(() => {
    if (!active || control?.state === 'paused') return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause)))
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [active, control?.state])
  if (!active || !control) return null
  const Icon = control.state === 'ready' ? ShieldCheck : control.state === 'running' ? Monitor : Pause
  const StopIcon = control.state === 'paused' ? X : Square
  return <section className="computer-status" data-state={control.state} data-testid="computer-control-status" aria-label="Computer control">
    <Icon size={16} aria-hidden />
    <div className="computer-status-copy" role="status">
      <strong>{computerStateLabel(control.state)}</strong>
      <span>{error || statusError || control.reason || (control.state === 'ready' ? 'Send this chat a task. Your mouse and keyboard stay yours until it starts.' : control.state === 'running' ? `Using your mouse and keyboard${control.name ? ` · ${control.name}` : ''}` : 'You have control. Resume only when you are ready.')}</span>
    </div>
    <button className="computer-stop" data-testid="computer-control-stop" onClick={stop}><StopIcon size={11} aria-hidden /><span>{control.state === 'paused' ? 'Dismiss' : 'Stop'}</span>{control.state !== 'paused' && <kbd>Esc</kbd>}</button>
  </section>
}
