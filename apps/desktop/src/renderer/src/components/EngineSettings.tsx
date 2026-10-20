import { Archive, ExternalLink, LoaderCircle, LogIn, MessageSquare, Users } from 'lucide-react'
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
import { SettingsItem, SettingsGroup } from './SettingsLayout.js'

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
        const notInstalled = id === 'claude' && state && !state.installed
        const signIn = pending ? status : connected ? 'Signed in with your account' : notInstalled ? 'Official runtime download. Anthropic’s terms apply.' : status
        return (
          <section key={id} className="settings-section engine-connection" aria-label={`${name} connection`}>
            <div className="engine-card-heading">
              <h3 className="settings-section-title engine-identity"><ProviderIcon provider={id} size={16} /> {name}</h3>
              <span className="engine-status" data-connected={status === 'Connected'} data-testid={`brain-${id}-status`} role="status">{(pending || !state) && <LoaderCircle size={14} className="computer-spinner" aria-hidden />}{status}</span>
            </div>
            <div className="settings-card">
              <SettingsItem icon={<Users size={18} />} title="Account" description={profileName}>{!pending && <AccountProfiles provider={id} label="Manage" />}</SettingsItem>
              <SettingsItem icon={<LogIn size={18} />} title="Sign-in" description={signIn} below={login?.message && <p className="engine-message" role="status">{login.message}</p>}>
                <span className="engine-actions">
                  {pending ? <>
                    {login.canOpen && <button className="secondary" onClick={() => run(api.engineOpenLogin(id))}><ExternalLink size={13} /> Open browser</button>}
                    <button className="secondary" data-testid={`brain-${id}-cancel`} onClick={() => run(api.engineCancelLogin(id))}>Cancel</button>
                  </> : connected ? <button className="secondary" data-testid={`brain-${id}-disconnect`} onClick={() => run(api.engineDisconnect(id).then(() => { setLogins((prior) => prior.filter((one) => one.id !== id)); setAttempt((value) => value + 1) }))}>Disconnect</button>
                    : state?.conclusive === false && state.healthReason !== 'auth' ? <button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry connection check</button>
                      : notInstalled ? <InstallClaude onInstalled={() => setAttempt(value => value + 1)} />
                        : <button className="secondary" data-testid={`brain-${id}-connect`} disabled={!state?.installed} onClick={() => run(api.engineConnect(id))}>Connect {name}</button>}
                </span>
              </SettingsItem>
              {!pending && <KeyConnection key={`${id}:${profiles?.selected[id]}:${attempt}`} provider={id} onChanged={() => setAttempt(value => value + 1)} />}
              {connected && <div className="settings-item settings-item-block"><AccountUsage provider={id} verified={connected} /></div>}
            </div>
          </section>
        )
      })}
      <SettingsGroup title="Defaults">
        <section aria-label="New conversation model"><SettingsItem icon={<MessageSquare size={18} />} title="New conversations" description="The AI a new conversation starts with."><ModelPicker showAccounts={false} /></SettingsItem></section>
        <section aria-label="Filing model"><SettingsItem icon={<Archive size={18} />} title="Filing & memory" description={checked ? 'The selected model answered.' : 'Sorts what you keep into Cosmos.'}>
          <ModelPicker scope="filing" showAccounts={false} />
          <button type="button" className="secondary" disabled={checking} data-testid="ai-check-filing" onClick={() => void check()}>{checking ? <><LoaderCircle size={14} className="computer-spinner" aria-hidden />Checking…</> : 'Test'}</button>
        </SettingsItem></section>
      </SettingsGroup>
      <section className="settings-section" aria-label="Decision model connection"><h3 className="settings-section-title">Advanced</h3><div className="settings-card"><KeyConnection provider="decision" /></div></section>
      {error && <div role="alert" className="engine-message">{error} <button className="secondary" onClick={() => { setError(''); setAttempt((value) => value + 1) }}>Retry</button></div>}
    </div>
  )
}
