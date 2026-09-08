import { Monitor, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettingsDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { desktopError, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'
import { computerStateLabel } from './ComputerStatus.js'

// One switch and one status line. There is no per-window consent to manage:
// a comet takes an app when a task needs it, the banner says so, and the
// person's own hands pause it. This switch is the way to say "never".
export function ComputerSettings() {
  const { available, control } = useDesktopSession()
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [error, setError] = useState('')
  const active = control && control.state !== 'idle'
  const dismiss = control?.state === 'paused' && !control.resumable
  useEffect(() => {
    let alive = true
    void api.settingsGet().then((next) => { if (alive) setSettings(next) }).catch((cause: unknown) => { if (alive) setError(desktopError(cause)) })
    const off = api.onEvent((event) => { if (event.type === 'settings:changed' && alive) setSettings(event.settings) })
    return () => { alive = false; off() }
  }, [])
  const enabled = settings?.computerUse === true
  const toggle = async (on: boolean) => {
    if (!settings) return
    setError('')
    const next = { ...settings, computerUse: on }
    setSettings(next)
    try { await api.settingsSet(next) } catch (cause) { setError(desktopError(cause)); setSettings(settings) }
  }
  const value = available === null ? 'Checking…' : available === false ? 'Unavailable on this build' : !enabled ? 'Off' : active && control ? computerStateLabel(control) : 'Ready when a task needs it'
  return <section className="computer-settings" aria-label="Computer use" data-testid="computer-settings">
    <div className="settings-group-head">Computer use</div>
    <label className="setting-row">
      <span className="computer-settings-label"><Monitor size={15} aria-hidden /><span>Let comets use this computer<small>{value}</small></span></span>
      <input type="checkbox" className="switch" data-testid="setting-computer-use" checked={enabled} disabled={!settings || available === false} onChange={(event) => void toggle(event.target.checked)} />
    </label>
    <p className="computer-settings-description">When a task needs an app, the comet brings it forward and works in it with your real mouse and keyboard. A banner on the screen names the brain at work. Move the mouse or type to pause it; press Esc or Stop to end it. Passwords, sign-in pages and security settings are never touched.</p>
    {active && <button className="computer-stop" onClick={() => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }}>{dismiss ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}{dismiss ? 'Dismiss' : 'Stop computer control'}{!dismiss && <kbd>Esc</kbd>}</button>}
    {error && <p className="computer-error" role="alert">{error}</p>}
  </section>
}
