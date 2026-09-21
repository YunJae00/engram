import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { DevPreferences, DevRule, DevState } from '../../../shared/developers.js'
import { api } from '../api.js'
import { ExternalConnections } from './ExternalConnections.js'

export function DeveloperSettings() {
  const [state, setState] = useState<DevState | null>(null), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const [collect, setCollect] = useState(false)
  const [rules, setRules] = useState<DevRule[]>([])
  useEffect(() => {
    let alive = true
    void Promise.all([api.devState(), api.sessionWatchGet()]).then(([value, watching]) => { if (alive) { setState(value); setCollect(watching) } }).catch(error => { if (alive) setError(error.message) })
    void api.devRules().then(value => { if (alive) setRules(value) }).catch(error => { if (alive) setError(error.message) })
    return () => { alive = false }
  }, [])
  const patch = async (change: Partial<DevPreferences>) => {
    setSaving(true); setError('')
    try { const preferences = await api.devPreferences(change); setState(current => current && { ...current, preferences }) }
    catch (error) { setError((error as Error).message) }
    finally { setSaving(false) }
  }
  if (!state) return <section><h3>Development tasks</h3>{error ? <p role="alert">{error}</p> : <p role="status"><LoaderCircle size={16} className="spin" /> Loading developer settings…</p>}</section>
  return <>
    <h3>Development tasks</h3>
    {saving && <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" aria-hidden />Saving…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="settings-group">
      <label className="setting-row"><span>Enable development workspace</span><input className="switch" type="checkbox" checked={state.preferences.enabled} disabled={saving} onChange={event => void patch({ enabled: event.target.checked })} /></label>
      <p className="setting-hint">Turning off stops tasks; files and history stay.</p>
    </div>
    <div className="settings-group">
      <label className="setting-row"><span>Remember coding sessions in Cosmos</span><input data-testid="setting-session-watch" className="switch" type="checkbox" checked={collect} disabled={saving} onChange={event => { setSaving(true); void api.sessionWatchSet(event.target.checked).then(setCollect).catch(error => setError(error.message)).finally(() => setSaving(false)) }} /></label>
      <p className="setting-hint">Saves session summaries to memory when enabled.</p>
    </div>
    <ExternalConnections />
    <div className="settings-group"><label className="setting-row"><span>Provider hooks &amp; project settings</span><input className="switch" type="checkbox" checked={state.preferences.loadProjectSettings} disabled={saving} onChange={event => void patch({ loadProjectSettings: event.target.checked })} /></label><p className="setting-hint">New full-access tasks only. Hooks, skills and MCP servers can run commands without Engram approval. Account-level connections are managed by your provider.</p></div>
    {rules.length > 0 && <div className="settings-group"><h3>Saved edit decisions</h3><p className="setting-hint">Applies only to matching inputs and content. Commands and sensitive actions still ask outside full access.</p>{rules.map(rule => <div className="setting-row" key={rule.id}><span>{state.repos.find(repo => repo.id === rule.repoId)?.name ?? 'Removed repository'} · {rule.tool} · {rule.decision}</span><button className="secondary" onClick={() => { void api.devRemoveRule(rule.id).then(() => setRules(current => current.filter(value => value.id !== rule.id))).catch(error => setError(error.message)) }}>Remove</button></div>)}</div>}
  </>
}
