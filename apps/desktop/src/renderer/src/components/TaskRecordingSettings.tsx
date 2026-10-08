import { Video } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettingsDto } from '../../../shared/types.js'
import { api } from '../api.js'

export function TaskRecordingSettings() {
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void api.settingsGet().then((next) => { if (alive) setSettings(next) }).catch(() => { if (alive) setError('Could not read settings.') })
    const off = api.onEvent((event) => { if (event.type === 'settings:changed' && alive) setSettings(event.settings) })
    return () => { alive = false; off() }
  }, [])
  const enabled = settings?.recordTasks !== false
  const toggle = async (on: boolean) => {
    if (!settings || saving) return
    setSaving(true); setError('')
    const next = { ...settings, recordTasks: on }
    setSettings(next)
    try { await api.settingsSet({ recordTasks: on }) } catch { setError('Could not save the setting.'); setSettings(settings) } finally { setSaving(false) }
  }
  return <section aria-label="Task recordings" data-testid="task-recording-settings">
    <label className="setting-row">
      <span className="computer-settings-label"><Video size={18} aria-hidden /><span>Task recordings</span></span>
      <input type="checkbox" className="switch" data-testid="setting-record-tasks" checked={enabled} disabled={!settings || saving} onChange={(event) => void toggle(event.target.checked)} />
    </label>
    <p className="computer-settings-description">Browser videos stay in this workspace. Password and card fields are masked; other page content is recorded.</p>
    {error && <p className="computer-error" role="alert">{error}</p>}
  </section>
}
