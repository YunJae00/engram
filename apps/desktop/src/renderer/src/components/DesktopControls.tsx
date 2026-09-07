import { useState } from 'react'
import { X } from 'lucide-react'
import type { DesktopObservationDto } from '../../../shared/desktop.js'
import { api } from '../api.js'

export function DesktopControls({ lane, close }: { lane: string; close(): void }) {
  const [observation, setObservation] = useState<DesktopObservationDto>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    setBusy(true); setError('')
    try { setObservation(await api.desktopObserve(lane)) } catch (cause) { setError(String(cause)) } finally { setBusy(false) }
  }
  const readable = observation?.nodes.filter((node) => node.name || node.value)
  return <div className="desktop-controls" role="dialog" aria-label="Window text">
    <header><span>Window text</span><button aria-label="Close window text" onClick={close}><X size={14} /></button></header>
    <p>Read-only text exposed by this app. It may not include everything visible in the window. Password fields are excluded.</p>
    <button className="desktop-text-button" disabled={busy} onClick={() => void refresh()}>{busy ? 'Reading…' : 'Read window text'}</button>
    {error && <p role="alert">{error}</p>}
    <div className="desktop-control-list">{readable?.map((node) => <div className="desktop-control-row" key={node.id}>
      <span>{node.name || node.controlType}</span>
      {node.value && node.value !== node.name && <p>{node.value}</p>}
    </div>)}</div>
    {observation && !readable?.length && <p>This window has no readable text. You can still view its screen here.</p>}
  </div>
}
