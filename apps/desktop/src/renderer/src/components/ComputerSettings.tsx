import { Eye, Monitor, Square, Unplug, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../api.js'
import { desktopError, hasDesktopGrant, refreshDesktop, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'

export function ComputerSettings() {
  const { available, bindings, control } = useDesktopSession()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = control && control.state !== 'idle'
  const disconnect = async (lane: string) => {
    setBusy(true); setError('')
    try { await api.desktopRelease(lane); await refreshDesktop() }
    catch (cause) { setError(desktopError(cause)) }
    finally { setBusy(false) }
  }
  return <section className="computer-settings" aria-label="Computer access" data-testid="computer-settings">
    <div className="settings-group-head">Computer access</div>
    <div className="setting-row"><span className="computer-settings-label"><Monitor size={15} aria-hidden />Foreground control</span><span className="computer-settings-value">{available === null ? 'Checking access…' : available === false ? 'Unavailable on this build' : active ? control.state === 'ready' ? 'Ready for a task' : control.state === 'running' ? 'On for one chat' : control.state === 'needs-person' ? 'Awaiting permission' : 'Paused' : 'Off'}</span></div>
    <p className="computer-settings-description">Choose Computer in a chat or Orbit, select a window, then allow access for that session. Your real mouse and keyboard are shared. Access is never enabled automatically.</p>
    {active && <button className="computer-stop" onClick={() => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }}>{control.state === 'paused' ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}{control.state === 'paused' ? 'Dismiss stopped session' : 'Stop computer control'}{control.state !== 'paused' && <kbd>Esc</kbd>}</button>}
    {bindings.length > 0 && <div className="computer-settings-bindings">{bindings.map((binding) => <div className="setting-row" key={binding.lane}><span className="computer-settings-label"><Eye size={14} aria-hidden /><span>{binding.name}<small>{binding.readable ? 'Reading allowed for this session' : 'Preview only'}</small></span></span><button className="computer-icon" title={`Disconnect ${binding.name}`} aria-label={`Disconnect ${binding.name}`} disabled={busy || hasDesktopGrant(control)} onClick={() => void disconnect(binding.lane)}><Unplug size={14} aria-hidden /></button></div>)}</div>}
    {error && <p className="computer-error" role="alert">{error}</p>}
  </section>
}
