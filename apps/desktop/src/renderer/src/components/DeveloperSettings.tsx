import { useEffect, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import type { DevPreferences, DevRule, DevState, DevUsage } from '../../../shared/developers.js'
import { api } from '../api.js'
import { ExternalConnections } from './ExternalConnections.js'

export function UsageSummary({ usage }: { usage: DevUsage | null }) {
  if (!usage) return <p className="setting-hint">Refresh to check your provider’s account limits.</p>
  return <div className="dev-usage">
    {usage.unavailable && <p className="setting-hint">{usage.unavailable}</p>}
    {usage.windows?.map((window, index) => <div key={`${window.name}-${index}`}>
      <div className="dev-usage-label"><span>{window.name}</span><span>{window.used === undefined ? 'Unavailable' : `${Math.round(100 - window.used)}% remaining`}</span></div>
      {window.used !== undefined && <progress max={100} value={100 - window.used} aria-label={`${window.name} remaining`} />}
      {window.resetsAt !== undefined && <small>Resets {new Date(window.resetsAt).toLocaleString('en-US')}</small>}
    </div>)}
    {usage.updatedAt && <small>Checked {new Date(usage.updatedAt).toLocaleTimeString('en-US')}</small>}
  </div>
}

export function DeveloperSettings() {
  const [state, setState] = useState<DevState | null>(null), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  const [collect, setCollect] = useState(false), [usage, setUsage] = useState<DevUsage | null>(null), [loadingUsage, setLoadingUsage] = useState(false)
  const [rules, setRules] = useState<DevRule[]>([])
  const [usageProvider, setUsageProvider] = useState<'claude' | 'codex'>('codex')
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
  if (!state) return <section><h2>Developers</h2>{error ? <p role="alert">{error}</p> : <p role="status"><LoaderCircle size={16} className="spin" /> Loading developer settings…</p>}</section>
  return <>
    <h2>Developers</h2><p className="setting-hint">Privacy, connections and safety. Manage projects and sessions from the sidebar in Developers mode.</p>
    {error && <p role="alert">{error}</p>}
    <div className="settings-group">
      <label className="setting-row"><span>Enable development workspace</span><input className="switch" type="checkbox" checked={state.preferences.enabled} disabled={saving} onChange={event => void patch({ enabled: event.target.checked })} /></label>
      <p className="setting-hint">Turning this off stops development tasks. Files and task history are kept.</p>
    </div>
    <div className="settings-group">
      <div className="dev-usage-label"><h3>Account usage</h3><button className="icon-btn" disabled={loadingUsage} aria-label="Refresh account usage" onClick={() => { setLoadingUsage(true); void api.devUsage(usageProvider).then(setUsage).catch(error => setError(error.message)).finally(() => setLoadingUsage(false)) }}>{loadingUsage ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}</button></div>
      <div className="workspace-mode-toggle" role="group" aria-label="Usage provider">{(['claude', 'codex'] as const).map(provider => <button key={provider} disabled={loadingUsage} aria-pressed={usageProvider === provider} onClick={() => { setUsageProvider(provider); setUsage(null) }}>{provider === 'claude' ? 'Claude' : 'Codex'}</button>)}</div>
      <UsageSummary usage={usage} />
      <p className="setting-hint">Provider-reported limits, not a billing estimate. Nothing is purchased or reset here.</p>
    </div>
    <div className="settings-group">
      <h3>Coding activity in Cosmos</h3>
      <label className="setting-row"><span>Remember coding sessions</span><input data-testid="setting-session-watch" className="switch" type="checkbox" checked={collect} disabled={saving} onChange={event => { setSaving(true); void api.sessionWatchSet(event.target.checked).then(setCollect).catch(error => setError(error.message)).finally(() => setSaving(false)) }} /></label>
      <p className="setting-hint">Collect sessions from connected coding tools into your memory. This is separate from running development tasks and stays off unless you enable it.</p>
    </div>
    <ExternalConnections />
    <div className="settings-group"><h3>Provider extensions</h3><label className="setting-row"><span>Load installed hooks and project configuration in full-access tasks</span><input className="switch" type="checkbox" checked={state.preferences.loadProjectSettings} disabled={saving} onChange={event => void patch({ loadProjectSettings: event.target.checked })} /></label><p className="setting-hint">Only newly created, explicitly confirmed full-access tasks use this setting. Installed hooks, skills and MCP servers can run commands outside Engram’s approval prompts. Configure them with your provider’s own configuration files. Review, plan and automatic-edit tasks do not enable project hooks. Provider account-level connections may still be available.</p></div>
    <div className="settings-group"><h3>Saved edit decisions</h3><p className="setting-hint">Exact tool input and starting content only. Shell commands and sensitive operations still ask in review and automatic-edit modes.</p>{rules.length ? rules.map(rule => <div className="setting-row" key={rule.id}><span>{state.repos.find(repo => repo.id === rule.repoId)?.name ?? 'Removed repository'} · {rule.tool} · {rule.decision}</span><button className="secondary" onClick={() => { void api.devRemoveRule(rule.id).then(() => setRules(current => current.filter(value => value.id !== rule.id))).catch(error => setError(error.message)) }}>Remove</button></div>) : <p className="setting-hint">No saved decisions.</p>}</div>
  </>
}
