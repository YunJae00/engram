import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle, X } from 'lucide-react'
import type { DevExternalSession, DevItem, DevProvider, DevRepo, DevSession } from '../../../shared/developers.js'
import { api } from '../api.js'
import { ProviderIcon } from './ProviderIcon.js'
import { DeveloperMessage } from './DeveloperTaskPane.js'

export function DeveloperHistory({ repo, provider, onClose, onImported }: { repo: DevRepo; provider: DevProvider; onClose(): void; onImported(task: DevSession): void }) {
  const dialog = useRef<HTMLDialogElement>(null), revision = useRef(0)
  const [engine, setEngine] = useState(provider), [rows, setRows] = useState<DevExternalSession[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [filter, setFilter] = useState('')
  const [preview, setPreview] = useState<{ session: DevExternalSession; items: DevItem[] } | null>(null)
  const [resumeConfirmed, setResumeConfirmed] = useState(false)
  const [allFolders, setAllFolders] = useState(false)
  useEffect(() => setResumeConfirmed(false), [preview?.session.id, engine])
  const continueSession = (fork: boolean) => {
    if (!preview) return
    setBusy(true); setError('')
    void api.devCreate({ repoId: repo.id, provider: engine, model: '', mode: 'review', isolate: false, resume: preview.session.id, fork, resumeConfirmed, allFolders }).then(onImported).catch(error => setError(error.message)).finally(() => setBusy(false))
  }
  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    const at = ++revision.current
    setLoading(true); setRows([]); setPreview(null); setError('')
    void api.devExternal(repo.id, engine, allFolders).then(rows => { if (at === revision.current) setRows(rows) }).catch(error => { if (at === revision.current) setError(error.message) }).finally(() => { if (at === revision.current) setLoading(false) })
    return () => { revision.current++ }
  }, [repo.id, engine, allFolders])
  return createPortal(<dialog className="dev-history-dialog" ref={dialog} aria-label={`Previous sessions in ${repo.name}`} onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header><div><h2>Previous sessions</h2><p>{repo.name} · Resume a conversation or start a separate branch.</p></div><button className="dev-control" aria-label="Close previous sessions" disabled={busy} onClick={onClose}><X size={17} /></button></header>
    <div className="dev-history-toolbar"><div className="workspace-mode-toggle" role="group" aria-label="Session provider">{(['claude', 'codex'] as const).map(value => <button key={value} disabled={busy} aria-pressed={engine === value} onClick={() => setEngine(value)}><ProviderIcon provider={value} size={14} />{value === 'claude' ? 'Claude' : 'Codex'}</button>)}</div><input type="search" aria-label="Search previous sessions" placeholder="Search sessions…" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    <label className="dev-history-scope"><input type="checkbox" checked={allFolders} disabled={busy} onChange={event => setAllFolders(event.target.checked)} />Include other folders <small>{allFolders ? '100 most recently updated sessions. Original folders are preserved.' : repo.path}</small></label>
    {error && <p role="alert">{error}</p>}<div className="dev-history-body"><nav aria-label="Previous sessions">{loading ? <p role="status"><LoaderCircle size={15} className="spin" />Loading sessions…</p> : rows.filter(row => `${row.title} ${row.cwd}`.toLowerCase().includes(filter.toLowerCase())).map(row => <button className={`dev-history-row${preview?.session.id === row.id ? ' selected' : ''}`} key={row.id} disabled={busy} onClick={() => { const at = ++revision.current; setBusy(true); setError(''); void api.devExternalRead(repo.id, engine, row.id, allFolders).then(items => { if (at === revision.current) setPreview({ session: row, items }) }).catch(error => { if (at === revision.current) setError(error.message) }).finally(() => setBusy(false)) }}><span>{row.title}</span><small>{row.active ? 'Active elsewhere' : new Date(row.updatedAt).toLocaleDateString('en-US')}</small>{allFolders && <small title={row.cwd}>{row.cwd}</small>}</button>)}{!loading && !rows.length && <p>No saved sessions found. Try including other folders.</p>}</nav><section aria-label="Saved session preview">{busy && <p role="status">Loading…</p>}{preview ? <><h3>{preview.session.title}</h3><p className="setting-hint">{preview.session.cwd}</p>{preview.items.map(item => <DeveloperMessage key={item.id} item={item} />)}{!preview.items.length && <p>No saved text messages.</p>}</> : <p className="setting-hint">Choose a session to preview its conversation.</p>}</section></div>
    <footer><label className="setting-hint"><input type="checkbox" checked={resumeConfirmed} disabled={!preview || busy} onChange={event => setResumeConfirmed(event.target.checked)} /> I have stopped this session in other apps.</label><div className="dev-actions"><button className="secondary" disabled={busy || !preview || preview.session.active} onClick={() => continueSession(true)}>Create a branch</button><button className="primary" disabled={busy || !preview || preview.session.active || !resumeConfirmed} onClick={() => continueSession(false)}>Resume session</button></div></footer>
  </dialog>, document.body)
}
