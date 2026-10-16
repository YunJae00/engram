import { ExternalLink, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EngineLoginDto, EngineStatusDto } from '../../../shared/types.js'
import { api, apiErrorText } from '../api.js'
import { ModelPicker } from './ModelPicker.js'
import { ProviderIcon } from './ProviderIcon.js'
import { InstallClaude } from './InstallClaude.js'
import { AccountProfiles } from './AccountProfiles.js'
import { AccountUsage } from './AccountUsage.js'
import type { AccountProfiles as Profiles } from '../../../shared/account-profiles.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'
import { connectionConfirmed, connectionLabel } from '../lib/connectionStatus.js'
import { KeyConnection } from './KeyConnection.js'

export function EngineSettings() {
  const [states, setStates] = useState<EngineStatusDto[] | null>(null)
  const [logins, setLogins] = useState<EngineLoginDto[]>([])
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)
  const profiles: Profiles | null = useAccountProfiles()
  useEffect(() => {
    let alive = true
    let revision = 0
    let probe = 0
    const refresh = () => {
      const at = ++probe
      for (const id of ['claude', 'codex'] as const) {
        const timer = window.setTimeout(() => { if (alive && at === probe) setStates(prior => [...(prior ?? []).filter(state => state.id !== id), { id, installed: true, loggedIn: false, conclusive: false }]) }, 16_000)
        void api.engineStates([id]).then(next => {
          if (alive && at === probe) setStates(prior => [...(prior ?? []).filter(state => state.id !== id), next.find(state => state.id === id) ?? { id, installed: false, loggedIn: false }])
        }).catch(() => { if (alive && at === probe) { setStates(prior => [...(prior ?? []).filter(state => state.id !== id), { id, installed: true, loggedIn: false, conclusive: false }]); setError('Could not check connections. Retry below.') } }).finally(() => window.clearTimeout(timer))
      }
    }
    refresh()
    void api.engineLogins().then((next) => { if (alive && revision === 0) setLogins(next) }).catch(() => {})
    const off = api.onEvent((event) => {
      if (event.type === 'settings:changed' || event.type === 'accounts:changed') setChecked(false)
      if (event.type === 'engines:login') {
        revision++
        setLogins((prior) => [...prior.filter((one) => one.id !== event.login.id || one.profile !== event.login.profile), event.login])
        if (['connected', 'idle', 'error'].includes(event.login.phase)) refresh()
      }
      if (event.type === 'accounts:changed') { setStates(null); refresh() }
      if (event.type === 'engines:detected' || event.type === 'engines:changed' || event.type === 'engine:health') refresh()
    })
    return () => { alive = false; off() }
  }, [attempt])
  const run = (operation: Promise<unknown>) => { setError(''); void operation.catch(() => setError('That did not finish. Please try again.')) }
  const check = async () => {
    if (checking) return
    setChecking(true); setChecked(false); setError('')
    try { await api.aiCheck(); setChecked(true); setAttempt(value => value + 1) }
    catch (cause) { setError(apiErrorText(cause instanceof Error ? cause.message : String(cause))) }
    finally { setChecking(false) }
  }
  return (
    <div className="engine-settings">
      {(['claude', 'codex'] as const).map((id) => {
        const state = states?.find((one) => one.id === id)
        const login = logins.find((one) => one.id === id && (one.profile ?? 'system') === (profiles?.selected[id] ?? 'system'))
        const pending = login?.phase === 'opening' || login?.phase === 'browser'
        const connected = connectionConfirmed(state)
        const name = id === 'claude' ? 'Claude' : 'ChatGPT'
        const profileName = profiles?.profiles.find(profile => profile.id === profiles.selected[id])?.name ?? 'System account'
        const status = pending ? login.phase === 'opening' ? 'Starting sign-in…' : 'Finish signing in in your browser' : connectionLabel(state, id)
        return (
          <section key={id} className="engine-card engine-connection" aria-label={`${name} connection`}>
            <div className="engine-card-heading"><div className="engine-identity"><strong><ProviderIcon provider={id} size={16} /> {name}</strong>{profileName && <small>{profileName}</small>}</div><span className="engine-status" data-connected={status === 'Connected'} data-testid={`brain-${id}-status`} role="status">{(pending || !state) && <LoaderCircle size={14} className="computer-spinner" aria-hidden />}{status}</span></div>
            <div className="engine-actions">
              {!pending && <AccountProfiles provider={id} />}
              {pending ? <>
                {login.canOpen && <button className="secondary" onClick={() => run(api.engineOpenLogin(id))}><ExternalLink size={13} /> Open browser</button>}
                <button className="secondary" data-testid={`brain-${id}-cancel`} onClick={() => run(api.engineCancelLogin(id))}>Cancel</button>
              </> : connected ? <>
                <button className="engine-disconnect" data-testid={`brain-${id}-disconnect`} onClick={() => run(api.engineDisconnect(id).then(() => { setLogins((prior) => prior.filter((one) => one.id !== id)); setAttempt((value) => value + 1) }))}>Disconnect</button>
              </> : state?.conclusive === false && state.healthReason !== 'auth' ? <button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry connection check</button> : id === 'claude' && state && !state.installed ? <InstallClaude onInstalled={() => setAttempt(value => value + 1)} /> : <button className="secondary" data-testid={`brain-${id}-connect`} disabled={!state?.installed} onClick={() => run(api.engineConnect(id))}>Connect {name}</button>}
              {!pending && <KeyConnection key={`${id}:${profiles?.selected[id]}:${attempt}`} provider={id} onChanged={() => setAttempt(value => value + 1)} />}
            </div>
            {login?.message && <p className="engine-message" role="status">{login.message}</p>}
            <AccountUsage provider={id} verified={connected} />
          </section>
        )
      })}
      <section className="engine-card" aria-label="Decision model connection"><strong>Decision model</strong><KeyConnection provider="decision" /></section>
      <div className="engine-card engine-defaults"><section className="setting-row" aria-label="New conversation model"><strong>New conversations</strong><ModelPicker showAccounts={false} /></section><section className="setting-row" aria-label="Filing model"><strong>Filing &amp; memory</strong><ModelPicker scope="filing" showAccounts={false} /><button type="button" className="secondary" disabled={checking} data-testid="ai-check-filing" onClick={() => void check()}>{checking ? <><LoaderCircle size={14} className="computer-spinner" aria-hidden />Checking…</> : 'Test AI'}</button></section>{checked && <p className="setting-hint" role="status">The selected filing model answered successfully.</p>}</div>
      {error && <div role="alert" className="engine-message">{error} <button className="secondary" onClick={() => { setError(''); setAttempt((value) => value + 1) }}>Retry</button></div>}
    </div>
  )
}
