import { RotateCw, X } from 'lucide-react'
import { useRef, useState, useEffect } from 'react'
import type { DesktopObservationDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { desktopError } from '../lib/desktopSession.js'

export function DesktopControls({ lane, close }: { lane: string; close(): void }) {
  const [observation, setObservation] = useState<DesktopObservationDto>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = async () => {
    setBusy(true); setError('')
    try { const next = await api.desktopObserve(lane); if (alive.current) setObservation(next) }
    catch (cause) { if (alive.current) setError(desktopError(cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  const readable = observation?.nodes.filter((node) => node.name || node.value)
  return <section className="desktop-controls" aria-label="Accessible window text">
    <header><strong>Window text</strong><button className="computer-icon" aria-label="Close window text" onClick={close}><X size={15} aria-hidden /></button></header>
    <p>Text this app exposes for reading. Some visible content may be unavailable. Password fields are excluded.</p>
    <button className="computer-secondary" disabled={busy} onClick={() => void refresh()}><RotateCw size={13} aria-hidden />{busy ? 'Reading…' : 'Read window text'}</button>
    {error && <p className="computer-error" role="alert">{error}</p>}
    <div className="desktop-control-list">{readable?.map((node) => <div className="desktop-control-row" key={node.id}>
      <span>{node.name || node.controlType}</span>
      {node.value && node.value !== node.name && <p>{node.value}</p>}
    </div>)}</div>
    {observation && !readable?.length && <p>No accessible text was found. The live preview is still available.</p>}
  </section>
}
