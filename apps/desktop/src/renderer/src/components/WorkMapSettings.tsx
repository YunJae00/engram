import { Map as MapIcon, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettingsDto, WorkMapStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'

// One switch: let comets learn where the person works from the browser on
// this computer, refreshed once a day in the background.
export function WorkMapSettings() {
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [status, setStatus] = useState<WorkMapStatusDto | null>(null)
  const [busy, setBusy] = useState(false)
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
    if (!settings) return
    setError('')
    const next = { ...settings, workMap: on }
    setSettings(next)
    try { await api.settingsSet(next) } catch { setError('Could not save the setting.'); setSettings(settings) }
  }
  const refresh = async () => {
    setBusy(true); setError('')
    try { setStatus(await api.workMapRefresh()) } catch { setError('Could not read the browser this time. Try again later.') } finally { setBusy(false) }
  }
  const summary = !enabled ? 'Off' : status?.builtAt ? `${status.places} work places · updated ${new Date(status.builtAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'Learning in the background…'
  return <section aria-label="Work places" data-testid="work-map-settings">
    <div className="settings-group-head">Where you work</div>
    <label className="setting-row">
      <span className="computer-settings-label"><MapIcon size={18} aria-hidden /><span>Learn from this browser<small>{summary}</small></span></span>
      <input type="checkbox" className="switch" data-testid="setting-work-map" checked={enabled} disabled={!settings} onChange={(event) => void toggle(event.target.checked)} />
    </label>
    <p className="computer-settings-description">Reads local browser history and bookmarks daily, without opening pages. Site names and titles are sent to your AI for labels. Work places become notes; edit the “Your notes” section to keep your additions. Turning this off stops learning; existing notes remain.</p>
    {enabled && <button className="secondary" data-testid="work-map-refresh" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? 'computer-spinner' : undefined} aria-hidden />{busy ? 'Updating…' : 'Update now'}</button>}
    {error && <p className="computer-error" role="alert">{error}</p>}
  </section>
}
