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
  const value = available === null ? 'Checking…' : available === false ? 'Unavailable on this build' : !enabled ? 'Off' : active && control ? computerStateLabel(control) : 'Ready'
  return <section className="computer-settings" aria-label="Computer use" data-testid="computer-settings">
    <div className="settings-group-head">Computer use</div>
    <label className="setting-row">
      <span className="computer-settings-label"><Monitor size={18} aria-hidden /><span>Control apps<small>{value}</small></span></span>
      <input type="checkbox" className="switch" data-testid="setting-computer-use" checked={enabled} disabled={!settings || available === false} onChange={(event) => void toggle(event.target.checked)} />
    </label>
    <p className="computer-settings-description">Use your mouse and keyboard to work in apps. Press <kbd>Esc</kbd> to stop.</p>
    <details className="computer-settings-details"><summary>How control works</summary><p>A desktop banner shows who is controlling the computer. Move the mouse or type to pause; press Esc or Stop to end control. Passwords, sign-in pages and security settings remain off limits.</p></details>
    {active && <button className="computer-stop" onClick={() => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }}>{dismiss ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}{dismiss ? 'Dismiss' : 'Stop computer control'}{!dismiss && <kbd>Esc</kbd>}</button>}
    {error && <p className="computer-error" role="alert">{error}</p>}
  </section>
}
