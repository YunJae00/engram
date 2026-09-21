import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, LoaderCircle, X } from 'lucide-react'
import type { DevExternalSession, DevItem, DevProvider, DevRepo, DevSession } from '../../../shared/developers.js'
import { api, apiErrorText } from '../api.js'
import { ProviderIcon } from './ProviderIcon.js'
import { DeveloperMessage } from './DeveloperTaskPane.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'

export function DeveloperHistory({ repo, provider, onClose, onImported }: { repo: DevRepo; provider: DevProvider; onClose(): void; onImported(task: DevSession): void }) {
  const dialog = useRef<HTMLDialogElement>(null), revision = useRef(0)
  const [engine, setEngine] = useState(provider), [rows, setRows] = useState<DevExternalSession[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<{ session: DevExternalSession; items: DevItem[] } | null>(null)
  const [resumeConfirmed, setResumeConfirmed] = useState(false)
  const [allFolders, setAllFolders] = useState(false)
  const [reload, setReload] = useState(0)
  const profiles = useAccountProfiles(), [chosenProfile, setChosenProfile] = useState<string | null>(null)
  const profile = chosenProfile ?? profiles?.selected[engine] ?? 'system'
  const errorText = (error: Error) => apiErrorText(error.message)
  const loadSession = (session: DevExternalSession) => {
    const at = ++revision.current
    setBusy(true); setError(''); setPreview({ session, items: [] }); setResumeConfirmed(false)
    void api.devExternalRead(repo.id, engine, session.id, allFolders, profile).then(items => { if (at === revision.current) setPreview({ session, items }) }).catch(error => { if (at === revision.current) setError(errorText(error)) }).finally(() => { if (at === revision.current) setBusy(false) })
  }
  useEffect(() => setResumeConfirmed(false), [preview?.session.id, engine])
  const continueSession = (fork: boolean) => {
    if (!preview) return
    setBusy(true); setError('')
    void api.devCreate({ repoId: repo.id, provider: engine, accountProfile: profile, model: '', mode: 'review', isolate: false, resume: preview.session.id, fork, resumeConfirmed, allFolders }).then(onImported).catch(error => setError(errorText(error))).finally(() => setBusy(false))
  }
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    const at = ++revision.current
    setLoading(true); setRows([]); setPreview(null); setError('')
    void api.devExternal(repo.id, engine, allFolders, profile).then(rows => { if (at === revision.current) setRows(rows) }).catch(error => { if (at === revision.current) setError(errorText(error)) }).finally(() => { if (at === revision.current) setLoading(false) })
    return () => { revision.current++ }
  }, [repo.id, engine, allFolders, profile, reload])
  return createPortal(<dialog className="dev-history-dialog" ref={dialog} aria-label={`Previous sessions in ${repo.name}`} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><div><h2>Previous sessions</h2><p>{repo.name} · Resume a conversation or start a separate branch.</p></div><button className="dev-control" aria-label="Close previous sessions" disabled={busy} onClick={onClose}><X size={17} /></button></header>
    <div className="dev-history-toolbar"><div className="workspace-mode-toggle" role="group" aria-label="Session provider">{(['claude', 'codex'] as const).map(value => <button key={value} disabled={busy} aria-pressed={engine === value} onClick={() => { setEngine(value); setChosenProfile(null) }}><ProviderIcon provider={value} size={14} />{value === 'claude' ? 'Claude' : 'Codex'}</button>)}</div><input type="search" aria-label="Search previous sessions" placeholder="Search sessions…" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    <label className="dev-history-scope">Account <select aria-label="Session account" value={profile} disabled={busy} onChange={event => setChosenProfile(event.target.value)}><option value="system">System account</option>{profiles?.profiles.filter(row => row.provider === engine).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
    <label className="dev-history-scope"><input type="checkbox" checked={allFolders} disabled={busy} onChange={event => setAllFolders(event.target.checked)} />Include other folders <small>{allFolders ? '100 recent conversations. Original folders are preserved.' : engine === 'codex' ? `${repo.path} · includes parent folders` : repo.path}</small></label>
    <div className="dev-history-body"><nav aria-label="Previous sessions">{loading ? <p role="status"><LoaderCircle size={15} className="spin" />Loading sessions…</p> : rows.filter(row => `${row.title} ${row.cwd}`.toLowerCase().includes(filter.toLowerCase())).map(row => <button className={`dev-history-row${preview?.session.id === row.id ? ' selected' : ''}`} key={row.id} disabled={busy} onClick={() => loadSession(row)}><span>{row.title}</span><small>{row.active ? 'Active elsewhere' : new Date(row.updatedAt).toLocaleDateString('en-US')}</small><small title={row.cwd}>{row.cwd}</small></button>)}{!loading && !rows.length && <div><p>No saved conversations in this account{allFolders ? '.' : ' for this folder.'}</p>{!allFolders && <button className="secondary" onClick={() => setAllFolders(true)}>Show other folders</button>}</div>}</nav><section aria-label="Saved session preview">
      {error ? <div className="dev-history-error" role="alert"><CircleAlert size={20} /><h3>{preview ? 'Could not load this session' : 'Could not load sessions'}</h3><p>Your original conversation has not been changed.</p><details><summary>Error details</summary><p>{error}</p></details><button className="secondary" onClick={() => preview ? loadSession(preview.session) : setReload(value => value + 1)}>Try again</button></div> : busy ? <p role="status"><LoaderCircle size={15} className="spin" />Loading conversation…</p> : preview ? <><h3>{preview.session.title}</h3><p className="setting-hint">{preview.session.cwd}</p><p className="setting-hint">Recent messages preview. Resuming keeps the original session history.</p>{preview.items.map(item => <DeveloperMessage key={item.id} item={item} />)}{!preview.items.length && <p>No saved text messages.</p>}</> : <p className="setting-hint">Choose a session to preview its conversation.</p>}
    </section></div>
    <footer><label className="setting-hint"><input type="checkbox" checked={resumeConfirmed} disabled={!preview || busy || !!error} onChange={event => setResumeConfirmed(event.target.checked)} /><span>I have stopped this session in other apps.</span></label><div className="dev-actions"><button className="secondary" disabled={busy || !!error || !preview || preview.session.active} onClick={() => continueSession(true)}>Create a branch</button><button className="primary" disabled={busy || !!error || !preview || preview.session.active || !resumeConfirmed} onClick={() => continueSession(false)}>Resume session</button></div></footer>
  </dialog>, document.body)
}
