import { Map as MapIcon, RefreshCw } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { AppSettingsDto, WorkMapStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'

export function WorkMapSettings() {
  const id = useId()
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [status, setStatus] = useState<WorkMapStatusDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void api.settingsGet().then((next) => { if (alive) setSettings(next) }).catch(() => { if (alive) setError('Could not read settings.') })
    void api.workMapStatus().then((next) => { if (alive) setStatus(next) }).catch(() => undefined)
    const off = api.onEvent((event) => {
      if (event.type === 'settings:changed' && alive) setSettings(event.settings)
      if (event.type === 'vault:changed') void api.workMapStatus().then(next => { if (alive) setStatus(next) }).catch(() => undefined)
    })
    return () => { alive = false; off() }
  }, [])
  const enabled = settings?.workMap === true
  const toggle = async (on: boolean) => {
    if (!settings || saving) return
    setSaving(true); setError('')
    const next = { ...settings, workMap: on }
    setSettings(next)
    try { await api.settingsSet({ workMap: on }) } catch { setError('Could not save the setting.'); setSettings(settings) } finally { setSaving(false) }
  }
  const refresh = async () => {
    setBusy(true); setError('')
    try { setStatus(await api.workMapRefresh()) } catch { setError('Could not read the browser this time. Try again later.') } finally { setBusy(false) }
  }
  const summary = status?.builtAt ? `${status.places} places · ${new Date(status.builtAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'Learning…'
  return <section aria-label="Work places" data-testid="work-map-settings">
    <div className="setting-row">
      <span className="computer-settings-label"><MapIcon size={18} aria-hidden /><span><label htmlFor={id}>Work places</label>{enabled && <small role="status">{busy ? 'Updating…' : summary}</small>}</span></span>
      {enabled && <button className="settings-icon-action" data-testid="work-map-refresh" aria-label="Update work places" title="Update work places" disabled={busy || saving} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? 'computer-spinner' : undefined} aria-hidden /></button>}
      <input id={id} type="checkbox" className="switch" data-testid="setting-work-map" checked={enabled} disabled={!settings || saving} onChange={(event) => void toggle(event.target.checked)} />
    </div>
    <p className="computer-settings-description">Site names and titles from history and bookmarks go to your AI daily. Pages stay closed.</p>
    <details className="settings-disclosure"><summary>Saved places</summary><p>Edit them in Cosmos. Turning this off keeps existing notes.</p></details>
    {error && <p className="computer-error" role="alert">{error}</p>}
  </section>
}
