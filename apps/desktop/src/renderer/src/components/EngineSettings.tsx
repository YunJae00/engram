import { Check, ExternalLink, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettingsDto, EngineLoginDto, EngineStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useModelChoices } from './ModelPicker.js'

export function EngineSettings({ settings, onChange }: { settings: AppSettingsDto; onChange(change: Partial<AppSettingsDto>): void }) {
  const [states, setStates] = useState<EngineStatusDto[] | null>(null)
  const [logins, setLogins] = useState<EngineLoginDto[]>([])
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    let revision = 0
    let probe = 0
    const refresh = () => {
      const at = ++probe
      void api.engineStates().then((next) => { if (alive && at === probe) setStates(next) }).catch(() => { if (alive && at === probe) setError('Could not check connections. Retry below.') })
    }
    refresh()
    void api.engineLogins().then((next) => { if (alive && revision === 0) setLogins(next) }).catch(() => {})
    const off = api.onEvent((event) => {
      if (event.type === 'engines:login') {
        revision++
        setLogins((prior) => [...prior.filter((one) => one.id !== event.login.id), event.login])
        if (['connected', 'idle', 'error'].includes(event.login.phase)) refresh()
      }
      if (event.type === 'engines:detected' || event.type === 'engines:changed') refresh()
    })
    return () => { alive = false; off() }
  }, [attempt])
  const run = (operation: Promise<unknown>) => { setError(''); void operation.catch(() => setError('That did not finish. Please try again.')) }
  return (
    <div className="engine-settings">
      <p className="setting-note">Connect your account, then choose who answers. Your plan’s limits and billing apply.</p>
      {(['claude', 'codex'] as const).map((id) => {
        const state = states?.find((one) => one.id === id)
        const login = logins.find((one) => one.id === id)
        const pending = login?.phase === 'opening' || login?.phase === 'browser'
        const connected = state?.loggedIn === true || login?.phase === 'connected'
        const selected = settings.defaultEngine === id
        const name = id === 'claude' ? 'Claude' : 'ChatGPT'
        const status = pending ? login.phase === 'opening' ? 'Starting sign-in…' : 'Finish signing in in your browser' : !states ? 'Checking connection…' : connected ? 'Connected' : state?.installed ? 'Not connected' : 'Runtime unavailable'
        return (
          <section key={id} className="engine-card" data-selected={selected} aria-label={`${name} connection`}>
            <div className="engine-card-heading"><strong>{name}</strong>{selected && <span className="engine-current"><Check size={12} /> In use</span>}</div>
            <div className="engine-status" data-testid={`brain-${id}-status`} role="status">{pending && <LoaderCircle size={14} className="computer-spinner" />}{status}</div>
            <div className="engine-actions">
              {pending ? <>
                {login.canOpen && <button className="secondary" onClick={() => run(api.engineOpenLogin(id))}><ExternalLink size={13} /> Open browser</button>}
                <button className="secondary" data-testid={`brain-${id}-cancel`} onClick={() => run(api.engineCancelLogin(id))}>Cancel</button>
              </> : connected ? <>
                <button className="secondary" data-testid={`brain-use-${id}`} disabled={selected} onClick={() => onChange({ defaultEngine: id })}>{selected ? 'Selected' : `Use ${name}`}</button>
                <button className="engine-disconnect" data-testid={`brain-${id}-disconnect`} onClick={() => run(api.engineDisconnect(id).then(() => { setLogins((prior) => prior.filter((one) => one.id !== id)); setAttempt((value) => value + 1) }))}>Disconnect</button>
              </> : <button className="secondary" data-testid={`brain-${id}-connect`} disabled={!state?.installed} onClick={() => run(api.engineConnect(id).then((result) => { if (result.ok) onChange({ defaultEngine: id }) }))}>Connect {name}</button>}
            </div>
            {login?.message && <p className="engine-message" role="status">{login.message}</p>}
            <EngineModel id={id} enabled={connected} value={(id === 'claude' ? settings.claudeModel : settings.codexModel) ?? ''} onChange={(value) => onChange(id === 'claude' ? { claudeModel: value } : { codexModel: value })} />
          </section>
        )
      })}
      {error && <div role="alert" className="engine-message">{error} <button className="secondary" onClick={() => { setError(''); setAttempt((value) => value + 1) }}>Retry</button></div>}
    </div>
  )
}

function EngineModel({ id, enabled, value, onChange }: { id: 'claude' | 'codex'; enabled: boolean; value: string; onChange(value: string): void }) {
  const { rows, loading, error, refresh } = useModelChoices(enabled ? id : null)
  return <div className="engine-model">
    <label htmlFor={`engine-model-${id}`}>Model</label>
    <select id={`engine-model-${id}`} className="settings-input" data-testid={`model-${id}`} value={value} disabled={!enabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">Auto · recommended</option>
      {rows.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
      {value && !rows.some((row) => row.value === value) && <option value={value}>{value}</option>}
    </select>
    {enabled && loading && <small role="status">Loading models… You can keep Auto.</small>}
    {enabled && error && <button className="engine-disconnect" onClick={refresh}>Could not load models · Retry</button>}
  </div>
}
