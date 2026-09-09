import { useEffect } from 'react'
import type { DesktopControlStatusDto } from '../../../shared/desktop.js'
import { desktopError, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'

export function computerStateLabel(control: DesktopControlStatusDto): string {
  const who = control.engineLabel ?? 'The comet'
  if (control.state === 'running') return `${who} is controlling your computer`
  if (control.state === 'ready') return `${who} is about to use your computer`
  if (control.state === 'needs-person') return 'Your attention is needed'
  return control.resumable ? 'You took over' : 'Computer control is off'
}

export function ComputerStatus() {
  const { control } = useDesktopSession()
  const active = Boolean(control && control.state !== 'idle')
  useEffect(() => {
    if (!active || (control?.state === 'paused' && !control.resumable)) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopImmediatePropagation()
      void stopComputerControl().catch((cause: unknown) => console.error(desktopError(cause)))
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [active, control?.state, control?.resumable])
  // Control feedback stays on the desktop; tool failures remain in the chat.
  return null
}
