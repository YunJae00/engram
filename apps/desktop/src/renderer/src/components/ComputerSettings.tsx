import { Monitor, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettingsDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { desktopError, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'
import { computerStateLabel } from './ComputerStatus.js'
import { SettingsItem, SettingsGroup } from './SettingsLayout.js'

// One switch and one status line. There is no per-window consent to manage:
// a comet takes an app when a task needs it, the banner says so, and the
// person's own hands pause it. This switch is the way to say "never".
export function ComputerSettings() {
  const { available, control } = useDesktopSession()
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
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
    if (!settings || saving) return
    setSaving(true); setError('')
    const next = { ...settings, computerUse: on }
    setSettings(next)
    try { await api.settingsSet({ computerUse: on }) } catch (cause) { setError(desktopError(cause)); setSettings(settings) } finally { setSaving(false) }
  }
  const value = available === null ? 'Checking…' : available === false ? 'Unavailable on this build' : !enabled ? 'Off' : active && control ? computerStateLabel(control) : 'Ready'
  return <div className="computer-settings" data-testid="computer-settings">
    <SettingsGroup title="Computer use">
      <SettingsItem icon={<Monitor size={18} />} title="Control apps" description="Uses your mouse and keyboard when a task needs an app. Move the mouse to pause, press Esc to stop. Passwords and sign-in pages stay off limits." htmlFor="setting-computer-use"
        below={(active || error) && <>
          {active && <button className="computer-stop" onClick={() => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }}>{dismiss ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}{dismiss ? 'Dismiss' : 'Stop computer control'}</button>}
          {error && <p className="computer-error" role="alert">{error}</p>}
        </>}>
        <span className="settings-item-state" role="status">{value}</span>
        <input id="setting-computer-use" type="checkbox" className="switch" data-testid="setting-computer-use" checked={enabled} disabled={!settings || saving || available === false} onChange={(event) => void toggle(event.target.checked)} />
      </SettingsItem>
    </SettingsGroup>
  </div>
}
