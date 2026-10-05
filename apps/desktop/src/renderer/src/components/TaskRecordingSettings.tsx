import { Video } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettingsDto } from '../../../shared/types.js'
import { api } from '../api.js'

// One switch: keep a video of what comets do in their own browser, so the
// person can watch how a task was done. On unless turned off.
export function TaskRecordingSettings() {
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void api.settingsGet().then((next) => { if (alive) setSettings(next) }).catch(() => { if (alive) setError('Could not read settings.') })
    const off = api.onEvent((event) => { if (event.type === 'settings:changed' && alive) setSettings(event.settings) })
    return () => { alive = false; off() }
  }, [])
  const enabled = settings?.recordTasks !== false
  const toggle = async (on: boolean) => {
    if (!settings) return
    setError('')
    const next = { ...settings, recordTasks: on }
    setSettings(next)
    try { await api.settingsSet(next) } catch { setError('Could not save the setting.'); setSettings(settings) }
  }
  return <section aria-label="Task recordings" data-testid="task-recording-settings">
    <label className="setting-row">
      <span className="computer-settings-label"><Video size={18} aria-hidden /><span>Record task work<small>{enabled ? 'On' : 'Off'}</small></span></span>
      <input type="checkbox" className="switch" data-testid="setting-record-tasks" checked={enabled} disabled={!settings} onChange={(event) => void toggle(event.target.checked)} />
    </label>
    <p className="computer-settings-description">While a comet works in its browser, Engram keeps a short video of that browser and links it under the answer. Password and card fields are blacked out; other page contents are recorded. Videos stay in this workspace.</p>
    {error && <p className="computer-error" role="alert">{error}</p>}
  </section>
}
