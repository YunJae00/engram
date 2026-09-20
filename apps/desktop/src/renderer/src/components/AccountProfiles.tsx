import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Users, X } from 'lucide-react'
import type { AccountProfiles as Profiles, AccountProvider } from '../../../shared/account-profiles.js'
import { api } from '../api.js'

export function AccountProfiles({ provider }: { provider: AccountProvider }) {
  const [open, setOpen] = useState(false)
  return <><button className="secondary" aria-label={`Manage ${provider === 'claude' ? 'Claude' : 'ChatGPT'} accounts`} onClick={() => setOpen(true)}><Users size={14} />Accounts</button>{open && <ProfileDialog provider={provider} close={() => setOpen(false)} />}</>
}
function ProfileDialog({ provider, close }: { provider: AccountProvider; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [profiles, setProfiles] = useState<Profiles | null>(null), [selected, setSelected] = useState('system'), [name, setName] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { dialog.current?.showModal(); let alive = true; void api.accountProfiles().then(value => { if (alive) { setProfiles(value); setSelected(value.selected[provider]) } }).catch(error => { if (alive) setError(error.message) }); return () => { alive = false } }, [provider])
  const act = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await work() } catch (error) { setError((error as Error).message) } finally { setBusy(false) } }
  return createPortal(<dialog className="account-profile-dialog" ref={dialog} aria-label="Account profiles" onCancel={event => { event.preventDefault(); if (!busy) close() }}>
    <header><h2>{provider === 'claude' ? 'Claude' : 'ChatGPT'} accounts</h2><button className="dev-control" aria-label="Close accounts" disabled={busy} onClick={close}><X size={17} /></button></header>
    <p>Each profile keeps its own sign-in and session history. Your existing sign-in stays in the system profile.</p>
    {!profiles ? <p role="status">Loading profiles…</p> : <fieldset disabled={busy}><legend>Use an account profile</legend>{[{ id: 'system', name: 'System account' }, ...profiles.profiles.filter(row => row.provider === provider)].map(row => <label key={row.id}><input type="radio" name="account-profile" checked={selected === row.id} onChange={() => setSelected(row.id)} /><span>{row.name}</span>{profiles.selected[provider] === row.id && <small>Current</small>}</label>)}</fieldset>}
    <form onSubmit={event => { event.preventDefault(); void act(async () => { const value = await api.accountProfileAdd(provider, name); setProfiles(value); setSelected(value.profiles.at(-1)!.id); setName('') }) }}><input aria-label="New account label" placeholder="Personal, Work…" maxLength={60} value={name} disabled={busy} onChange={event => setName(event.target.value)} /><button className="secondary" disabled={busy || !name.trim()}>Add account</button></form>
    <p className="setting-hint">Switching restarts Engram to isolate runtime settings. Finish active work first. Connect the selected account after reopening; sign-ins are never copied between profiles.</p>
    {error && <p role="alert">{error}</p>}
    <footer><button className="secondary" disabled={busy} onClick={close}>Cancel</button><button className="primary" disabled={busy || !profiles || selected === profiles.selected[provider]} onClick={() => void act(() => api.accountProfileUse(provider, selected))}>Use profile and restart</button></footer>
  </dialog>, document.body)
}
