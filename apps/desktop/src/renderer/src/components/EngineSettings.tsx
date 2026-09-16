import { ExternalLink, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EngineLoginDto, EngineStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { ModelPicker } from './ModelPicker.js'
import { ProviderIcon } from './ProviderIcon.js'
import { InstallClaude } from './InstallClaude.js'

export function EngineSettings() {
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
      <p className="setting-note">Use either connected account in any conversation.</p>
      <section className="engine-card" aria-label="New conversation model"><strong>New conversations</strong><p className="setting-note">A starting choice. Existing conversations keep their own settings.</p><ModelPicker /></section>
      <section className="engine-card" aria-label="Filing model"><strong>Filing & memory</strong><p className="setting-note">Organize notes and maintain memory independently of your conversations.</p><ModelPicker scope="filing" /></section>
      {(['claude', 'codex'] as const).map((id) => {
        const state = states?.find((one) => one.id === id)
        const login = logins.find((one) => one.id === id)
        const pending = login?.phase === 'opening' || login?.phase === 'browser'
        const connected = state?.loggedIn === true || login?.phase === 'connected'
        const name = id === 'claude' ? 'Claude' : 'ChatGPT'
        const status = pending ? login.phase === 'opening' ? 'Starting sign-in…' : 'Finish signing in in your browser' : !states ? 'Checking connection…' : connected ? 'Connected' : state?.installed ? 'Not connected' : id === 'claude' ? 'Not installed' : 'Runtime unavailable'
        return (
          <section key={id} className="engine-card" aria-label={`${name} connection`}>
            <div className="engine-card-heading"><strong><ProviderIcon provider={id} size={16} /> {name}</strong></div>
            <div className="engine-status" data-testid={`brain-${id}-status`} role="status">{(pending || !states) && <LoaderCircle size={14} className="computer-spinner" aria-hidden />}{status}</div>
            <div className="engine-actions">
              {pending ? <>
                {login.canOpen && <button className="secondary" onClick={() => run(api.engineOpenLogin(id))}><ExternalLink size={13} /> Open browser</button>}
                <button className="secondary" data-testid={`brain-${id}-cancel`} onClick={() => run(api.engineCancelLogin(id))}>Cancel</button>
              </> : connected ? <>
                <button className="engine-disconnect" data-testid={`brain-${id}-disconnect`} onClick={() => run(api.engineDisconnect(id).then(() => { setLogins((prior) => prior.filter((one) => one.id !== id)); setAttempt((value) => value + 1) }))}>Disconnect</button>
              </> : id === 'claude' && state && !state.installed ? <InstallClaude onInstalled={() => setAttempt(value => value + 1)} /> : <button className="secondary" data-testid={`brain-${id}-connect`} disabled={!state?.installed} onClick={() => run(api.engineConnect(id))}>Connect {name}</button>}
            </div>
            {login?.message && <p className="engine-message" role="status">{login.message}</p>}
          </section>
        )
      })}
      {error && <div role="alert" className="engine-message">{error} <button className="secondary" onClick={() => { setError(''); setAttempt((value) => value + 1) }}>Retry</button></div>}
    </div>
  )
}
