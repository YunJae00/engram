import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, LoaderCircle, Users, X } from 'lucide-react'
import type { AccountProfileState, AccountProvider } from '../../../shared/account-profiles.js'
import type { EngineLoginDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'
import { useAccountUsage } from '../lib/accountUsage.js'
import { UsageSummary } from './AccountUsage.js'
import { AccountLimit } from './AccountLimit.js'
import { ProviderIcon } from './ProviderIcon.js'
import { connectionConfirmed, connectionLabel } from '../lib/connectionStatus.js'
import { t } from '../i18n.js'

export function AccountProfiles({ provider, compact = false, sessionProfile, label }: { provider: AccountProvider; compact?: boolean; sessionProfile?: string; label?: string }) {
  const [open, setOpen] = useState(false), profiles = useAccountProfiles()
  const id = sessionProfile ?? profiles?.selected[provider] ?? 'system'
  const name = profiles?.profiles.find(row => row.id === id)?.name ?? t('model.systemAccount')
  return <>{compact ? <AccountLimit provider={provider} profile={id} name={name} onClick={() => setOpen(true)} /> : <button type="button" className="secondary" aria-label={t('model.manageAccounts', { provider: provider === 'claude' ? 'Claude' : 'ChatGPT' })} onClick={() => setOpen(true)}><Users size={16} />{label ?? t('settingsUi.manageAccounts')}</button>}{open && <ProfileDialog provider={provider} sessionProfile={sessionProfile} close={() => setOpen(false)} />}</>
}
export function ProfileDialog({ provider, sessionProfile, close }: { provider: AccountProvider; sessionProfile?: string; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), profiles = useAccountProfiles(), usage = useAccountUsage()
  const [states, setStates] = useState<AccountProfileState[]>([]), [logins, setLogins] = useState<EngineLoginDto[]>([])
  const [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    let alive = true, revision = 0
    const refresh = () => { const at = ++revision; void api.accountProfileStates().then(value => { if (alive && at === revision) setStates(value) }).catch(error => { if (alive) setError(error.message) }) }
    refresh(); void api.engineLogins().then(value => { if (alive) setLogins(value) }).catch(() => { if (alive) setError(t('settingsUi.signInProgressFailed')) })
    const off = api.onEvent(event => {
      if (event.type === 'accounts:changed' || event.type === 'engine:health') refresh()
      if (event.type === 'engines:login') {
        setLogins(rows => [...rows.filter(row => row.id !== event.login.id || row.profile !== event.login.profile), event.login])
        if (['connected', 'idle', 'error'].includes(event.login.phase)) refresh()
      }
    })
    return () => { alive = false; off() }
  }, [attempt])
  const act = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await work() } catch (error) { setError((error as Error).message) } finally { setBusy(false) } }
  const connect = (id: string) => { setError(''); void api.engineConnect(provider, id).then(result => { if (!result.ok && result.message) setError(result.message) }).catch(error => setError(error.message)) }
  const rows = [{ id: 'system', name: t('model.systemAccount') }, ...(profiles?.profiles.filter(row => row.provider === provider) ?? [])]
  return createPortal(<dialog className="account-profile-dialog" ref={dialog} aria-label={t('settingsUi.accountProfiles')} onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <header><h2><ProviderIcon provider={provider} size={24} />{t('settingsUi.providerAccounts', { provider: provider === 'claude' ? 'Claude' : 'ChatGPT' })}</h2><button className="dev-control" aria-label={t('settingsUi.closeAccounts')} disabled={busy} onClick={close}><X size={17} /></button></header>
    {sessionProfile && <p className="setting-hint">{t('settingsUi.runningKeep')}</p>}
    {busy && <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" aria-hidden />{t('settingsUi.updatingAccount')}</p>}
    <div className="account-profile-list">{rows.map(row => {
      const state = states.find(value => value.provider === provider && value.id === row.id)
      const login = logins.find(value => value.id === provider && (value.profile ?? 'system') === row.id)
      const pending = login?.phase === 'opening' || login?.phase === 'browser'
      const connected = connectionConfirmed(state)
      const current = profiles?.selected[provider] === row.id
      const limits = usage.find(value => value.provider === provider && value.profile === row.id)
      return <section key={row.id} className="account-profile-row" data-selected={current} aria-label={row.name}>
        <header><div><strong><ProviderIcon provider={provider} size={16} />{row.name}{current && <span className="account-selected">{t('settingsUi.selected')}</span>}</strong><small>{sessionProfile === row.id ? t('settingsUi.usedBySession') : pending ? t('settingsUi.finishSignIn') : connectionLabel(state, provider)}</small></div>
          {pending ? <div className="dev-actions">{login.canOpen && <button className="secondary" onClick={() => void act(() => api.engineOpenLogin(provider, row.id))}>{t('settingsUi.openBrowser')}</button>}<button className="secondary" onClick={() => void act(() => api.engineCancelLogin(provider, row.id))}>{t('settingsUi.cancelSignIn')}</button></div>
            : connected ? <button className="secondary" disabled={busy || current} onClick={() => void act(async () => { await api.accountProfileUse(provider, row.id); close() })}>{current ? <><Check size={14} />{t('settingsUi.current')}</> : t('settingsUi.useAccount')}</button>
              : state?.conclusive === false && state.healthReason !== 'auth' ? <button className="secondary" disabled={busy} onClick={() => setAttempt(value => value + 1)}>{t('settingsUi.retryCheck')}</button> : <button className="secondary" disabled={busy || !state?.installed} onClick={() => connect(row.id)}>{!state ? <LoaderCircle size={14} className="spin" /> : t('model.connect')}</button>}
        </header>
        {connected && <UsageSummary usage={limits?.usage ?? null} />}
      </section>
    })}</div>
    <form onSubmit={event => { event.preventDefault(); void act(async () => { await api.accountProfileAdd(provider, name); setName(''); setAttempt(value => value + 1) }) }}><input aria-label={t('settingsUi.newAccountLabel')} placeholder={t('settingsUi.accountPlaceholder')} maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /><button className="secondary" disabled={busy || !name.trim()}>{t('settingsUi.addAccount')}</button></form>
    <p className="setting-hint account-profile-note">{t('settingsUi.signInOnce')}</p>
    {error && <p role="alert">{error}</p>}
    <footer><button className="secondary" disabled={busy} onClick={close}>{t('settingsUi.done')}</button></footer>
  </dialog>, document.body)
}
