import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, LoaderCircle, Users, X } from 'lucide-react'
import type { AccountProfileState, AccountProvider } from '../../../shared/account-profiles.js'
import type { EngineLoginDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'
import { useAccountUsage } from '../lib/accountUsage.js'
import { UsageSummary } from './AccountUsage.js'

export function AccountProfiles({ provider, compact = false, sessionProfile }: { provider: AccountProvider; compact?: boolean; sessionProfile?: string }) {
  const [open, setOpen] = useState(false), profiles = useAccountProfiles()
  const id = sessionProfile ?? profiles?.selected[provider] ?? 'system'
  const name = profiles?.profiles.find(row => row.id === id)?.name ?? 'System account'
  return <><button type="button" className={compact ? 'model-picker-btn account-picker' : 'secondary'} title={`${name} · Accounts`} aria-label={`Manage ${provider === 'claude' ? 'Claude' : 'ChatGPT'} accounts`} onClick={() => setOpen(true)}><Users size={16} />{compact ? id !== 'system' && <span>{name}</span> : 'Accounts'}</button>{open && <ProfileDialog provider={provider} sessionProfile={sessionProfile} close={() => setOpen(false)} />}</>
}
function ProfileDialog({ provider, sessionProfile, close }: { provider: AccountProvider; sessionProfile?: string; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), profiles = useAccountProfiles(), usage = useAccountUsage()
  const [states, setStates] = useState<AccountProfileState[]>([]), [logins, setLogins] = useState<EngineLoginDto[]>([])
  const [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    let alive = true, revision = 0
    const refresh = () => { const at = ++revision; void api.accountProfileStates().then(value => { if (alive && at === revision) setStates(value) }).catch(error => { if (alive) setError(error.message) }) }
    refresh(); void api.engineLogins().then(value => { if (alive) setLogins(value) }).catch(() => { if (alive) setError('Could not check sign-in progress. Reopen accounts to retry.') })
    const off = api.onEvent(event => {
      if (event.type === 'accounts:changed') refresh()
      if (event.type === 'engines:login') {
        setLogins(rows => [...rows.filter(row => row.id !== event.login.id || row.profile !== event.login.profile), event.login])
        if (['connected', 'idle', 'error'].includes(event.login.phase)) refresh()
      }
    })
    return () => { alive = false; off() }
  }, [attempt])
  const act = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await work() } catch (error) { setError((error as Error).message) } finally { setBusy(false) } }
  const connect = (id: string) => { setError(''); void api.engineConnect(provider, id).then(result => { if (!result.ok && result.message) setError(result.message) }).catch(error => setError(error.message)) }
  const rows = [{ id: 'system', name: 'System account' }, ...(profiles?.profiles.filter(row => row.provider === provider) ?? [])]
  return createPortal(<dialog className="account-profile-dialog" ref={dialog} aria-label="Account profiles" onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <header><h2>{provider === 'claude' ? 'Claude' : 'ChatGPT'} accounts</h2><button className="dev-control" aria-label="Close accounts" disabled={busy} onClick={close}><X size={17} /></button></header>
    <p>Stay signed in to multiple accounts. Switch instantly without restarting.</p>
    {sessionProfile && <p className="setting-hint">This development session keeps its original account. Your selection applies to new tasks and the next ordinary chat turn.</p>}
    <div className="account-profile-list">{rows.map(row => {
      const state = states.find(value => value.provider === provider && value.id === row.id)
      const login = logins.find(value => value.id === provider && (value.profile ?? 'system') === row.id)
      const pending = login?.phase === 'opening' || login?.phase === 'browser'
      const connected = state?.loggedIn || login?.phase === 'connected'
      const current = profiles?.selected[provider] === row.id
      const limits = usage.find(value => value.provider === provider && value.profile === row.id)
      return <section key={row.id} className="account-profile-row" aria-label={row.name}>
        <header><div><strong>{row.name}</strong><small>{pending ? 'Finish sign-in in your browser' : connected ? 'Connected' : state ? 'Not connected' : 'Checking connection…'}</small></div>
          {pending ? <div className="dev-actions">{login.canOpen && <button className="secondary" onClick={() => void act(() => api.engineOpenLogin(provider, row.id))}>Open browser</button>}<button className="secondary" onClick={() => void act(() => api.engineCancelLogin(provider, row.id))}>Cancel sign-in</button></div>
            : connected ? <button className="secondary" disabled={busy || current} onClick={() => void act(async () => { await api.accountProfileUse(provider, row.id); close() })}>{current ? <><Check size={14} />Current</> : 'Use account'}</button>
              : <button className="secondary" disabled={busy || !state?.installed} onClick={() => connect(row.id)}>{!state ? <LoaderCircle size={14} className="spin" /> : 'Connect'}</button>}
        </header>
        {connected && <UsageSummary usage={limits?.usage ?? null} />}
      </section>
    })}</div>
    <form onSubmit={event => { event.preventDefault(); void act(async () => { await api.accountProfileAdd(provider, name); setName(''); setAttempt(value => value + 1) }) }}><input aria-label="New account label" placeholder="Personal, Work…" maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /><button className="secondary" disabled={busy || !name.trim()}>Add account</button></form>
    <p className="setting-hint">Sign in once per account. Switching does not sign out other accounts or move running work. Provider limits still apply.</p>
    {error && <p role="alert">{error}</p>}
    <footer><button className="secondary" disabled={busy} onClick={close}>Done</button></footer>
  </dialog>, document.body)
}
