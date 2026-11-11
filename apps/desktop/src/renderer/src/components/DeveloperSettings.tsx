import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { DevPreferences, DevRule, DevState } from '../../../shared/developers.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
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
  if (!state) return <section>{error ? <p role="alert">{error}</p> : <p role="status"><LoaderCircle size={16} className="spin" /> {t('settingsUi.loading')}</p>}</section>
  return <>
    {saving && <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" aria-hidden />{t('settingsUi.saving')}</p>}
    {error && <p role="alert">{error}</p>}
    <details className="settings-disclosure"><summary>{t('settingsUi.devTools')}</summary>
    <div className="settings-group">
      <label className="setting-row"><span>{t('settingsUi.developers')}</span><input className="switch" type="checkbox" checked={state.preferences.enabled} disabled={saving} onChange={event => void patch({ enabled: event.target.checked })} /></label>
      <p className="setting-hint">{t('settingsUi.devOffHint')}</p>
    </div>
    <div className="settings-group">
      <label className="setting-row"><span>{t('settingsUi.rememberSessions')}</span><input data-testid="setting-session-watch" className="switch" type="checkbox" checked={collect} disabled={saving} onChange={event => { setSaving(true); void api.sessionWatchSet(event.target.checked).then(setCollect).catch(error => setError(error.message)).finally(() => setSaving(false)) }} /></label>
    </div>
    {rules.length > 0 && <div className="settings-group"><h3>{t('settingsUi.savedDecisions')}</h3><p className="setting-hint">{t('settingsUi.savedDecisionsHint')}</p>{rules.map(rule => <div className="setting-row" key={rule.id}><span>{state.repos.find(repo => repo.id === rule.repoId)?.name ?? t('settingsUi.removedRepo')} · {rule.tool} · {rule.decision}</span><button className="secondary" onClick={() => { void api.devRemoveRule(rule.id).then(() => setRules(current => current.filter(value => value.id !== rule.id))).catch(error => setError(error.message)) }}>{t('settingsUi.remove')}</button></div>)}</div>}
    </details>
    <ExternalConnections />
    <details className="settings-disclosure"><summary>{t('settingsUi.providerIntegrations')}</summary>
      <div className="settings-group"><label className="setting-row"><span>{t('settingsUi.providerHooks')}</span><input className="switch" type="checkbox" checked={state.preferences.loadProjectSettings} disabled={saving} onChange={event => void patch({ loadProjectSettings: event.target.checked })} /></label><p className="setting-hint">{t('settingsUi.providerHooksHint')}</p></div>
    </details>
  </>
}
