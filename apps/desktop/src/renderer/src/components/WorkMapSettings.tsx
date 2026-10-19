import { AppWindow, FolderOpen, Map as MapIcon, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettingsDto, WorkMapStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { LEARNING_SOURCES } from './LearningSources.js'
import { SettingsItem } from './SettingsLayout.js'

type SourceKey = 'workMap' | 'workFiles' | 'workApps'
const ROWS: { key: SourceKey; testId: string; Icon: typeof MapIcon }[] = [
  { key: 'workMap', testId: 'setting-work-map', Icon: MapIcon },
  { key: 'workFiles', testId: 'setting-work-files', Icon: FolderOpen },
  { key: 'workApps', testId: 'setting-work-apps', Icon: AppWindow },
]

export function WorkMapSettings() {
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
  const toggle = async (key: SourceKey, on: boolean) => {
    if (!settings || saving) return
    setSaving(true); setError('')
    setSettings({ ...settings, [key]: on })
    try { await api.settingsSet({ [key]: on }) } catch { setError('Could not save the setting.'); setSettings(settings) } finally { setSaving(false) }
  }
  const refresh = async () => {
    setBusy(true); setError('')
    try { setStatus(await api.workMapRefresh()) } catch { setError('Could not read the browser this time. Try again later.') } finally { setBusy(false) }
  }
  const summary = status?.builtAt ? `${status.places} places · ${new Date(status.builtAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'Learning…'
  return <div className="settings-items" data-testid="work-map-settings">
    {ROWS.map(({ key, testId, Icon }) => {
      const source = LEARNING_SOURCES.find(one => one.key === key)!
      const enabled = settings?.[key] === true
      return <SettingsItem key={key} icon={<Icon size={18} />} title={source.name} htmlFor={testId} description={key === 'workMap' && enabled ? (busy ? 'Updating…' : summary) : source.detail}>
        {key === 'workMap' && enabled && <button className="settings-icon-action" data-testid="work-map-refresh" aria-label="Update work places" title="Update work places" disabled={busy || saving} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? 'computer-spinner' : undefined} aria-hidden /></button>}
        <input id={testId} type="checkbox" className="switch" data-testid={testId} checked={enabled} disabled={!settings || saving} onChange={(event) => void toggle(key, event.target.checked)} />
      </SettingsItem>
    })}
    {error && <p className="computer-error" role="alert">{error}</p>}
  </div>
}
