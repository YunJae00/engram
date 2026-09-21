import { useEffect, useRef, useState } from 'react'
import { File, Folder, ArrowLeft, X } from 'lucide-react'
import type { DevFile, DevFileEntry, DevFileMatch, DevWorkspace } from '../../../shared/developers.js'
import { api, apiErrorText } from '../api.js'
import { DeveloperEditor } from './DeveloperEditor.js'
import { usePaneSurface } from '../lib/usePaneSurface.js'

export function DeveloperFiles({ workspace, locked, onClose, onAttach }: { workspace: DevWorkspace; locked: boolean; onClose(): void; onAttach(text: string): void }) {
  const [directory, setDirectory] = useState(''), [entries, setEntries] = useState<DevFileEntry[]>([]), [truncated, setTruncated] = useState(false), [filter, setFilter] = useState('')
  const [file, setFile] = useState<DevFile | null>(null), [text, setText] = useState(''), [selection, setSelection] = useState(''), [revision, setRevision] = useState(0)
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false), [listing, setListing] = useState(false)
  const [query, setQuery] = useState(''), [matches, setMatches] = useState<DevFileMatch[] | null>(null), [searching, setSearching] = useState(false), [searchLimited, setSearchLimited] = useState(false)
  const [newPath, setNewPath] = useState(''), [line, setLine] = useState<number>()
  const serial = useRef(0), gate = useRef(false)
  const latestText = useRef(text)
  latestText.current = text
  const key = (path: string) => `engram.dev.file.${workspace.sessionId ?? workspace.repoId}.${path}`
  const dirty = !!file && text !== file.text
  const surface = usePaneSurface(() => { if (!busy) onClose() })
  useEffect(() => {
    let alive = true; setListing(true); setError('')
    void api.devFiles(workspace, directory).then(result => { if (alive) { setEntries(result.entries); setTruncated(result.truncated) } }).catch(error => { if (alive) setError(apiErrorText(error.message)) }).finally(() => { if (alive) setListing(false) })
    return () => { alive = false }
  }, [workspace.repoId, workspace.sessionId, directory])
  useEffect(() => () => { serial.current++ }, [])
  const load = async (path: string, discard = false, targetLine?: number) => {
    if (gate.current) return
    const at = ++serial.current; setBusy(true); setError(''); setStatus('')
    try {
      const result = await api.devReadFile(workspace, path)
      if (at !== serial.current) return
      let draft: { text: string; fingerprint: string } | null = null
      try { if (discard) localStorage.removeItem(key(path)); else { const value = JSON.parse(localStorage.getItem(key(path)) ?? 'null'); if (value && typeof value.text === 'string' && typeof value.fingerprint === 'string') draft = value } } catch { /* In-memory drafts still work. */ }
      setFile(draft ? { ...result, fingerprint: draft.fingerprint } : result); setText(draft?.text ?? result.text); setSelection(''); setLine(targetLine); setRevision(value => value + 1)
      if (draft && draft.text !== result.text) setStatus(draft.fingerprint === result.fingerprint ? 'Restored unsaved draft. Review before saving.' : 'Disk contents changed since this draft. Copy your draft before discarding and reloading.')
    } catch (error) { if (at === serial.current) setError(apiErrorText((error as Error).message)) }
    finally { if (at === serial.current) setBusy(false) }
  }
  const change = (value: string) => {
    setText(value); setStatus('')
    if (file) try { if (value === file.text) localStorage.removeItem(key(file.path)); else localStorage.setItem(key(file.path), JSON.stringify({ text: value, fingerprint: file.fingerprint })) } catch { setStatus('Draft could not be cached. Keep this editor open until saved.') }
  }
  const save = async () => {
    if (!file || gate.current || busy || locked) return
    gate.current = true; setBusy(true); setError(''); setStatus('')
    try {
      const result = await api.devSaveFile(workspace, file.path, file.fingerprint, text)
      setFile(result); setStatus('Saved. Previous content kept in workspace recovery backups.')
      try {
        if (latestText.current === result.text) localStorage.removeItem(key(file.path))
        else localStorage.setItem(key(file.path), JSON.stringify({ text: latestText.current, fingerprint: result.fingerprint }))
      } catch { /* The current editor retains any newer draft. */ }
    } catch (error) { setError(apiErrorText((error as Error).message)) }
    finally { gate.current = false; setBusy(false) }
  }
  const attach = () => {
    if (!file) return
    const content = selection || text
    if (content.length > 20_000) { setError('Select a smaller code section to attach (up to 20,000 characters).'); return }
    onAttach(`Context from ${JSON.stringify(file.path)}${selection ? ' (selected text)' : ''}${dirty ? ' (unsaved draft)' : ''}:\n${content}`)
    onClose()
  }
  const search = async () => {
    if (searching || !query.trim()) return
    setSearching(true); setError('')
    try { const result = await api.devSearchFiles(workspace, query); setMatches(result.matches); setSearchLimited(result.truncated) }
    catch (error) { setError(apiErrorText((error as Error).message)) }
    finally { setSearching(false) }
  }
  const create = async () => {
    if (gate.current || busy || locked || !newPath.trim()) return
    gate.current = true; setBusy(true); setError('')
    try {
      const result = await api.devCreateFile(workspace, directory ? `${directory}/${newPath.trim()}` : newPath.trim())
      setNewPath(''); setFile(result); setText(result.text); setSelection(''); setLine(undefined); setRevision(value => value + 1)
      const listing = await api.devFiles(workspace, directory); setEntries(listing.entries); setTruncated(listing.truncated)
    } catch (error) { setError(apiErrorText((error as Error).message)) }
    finally { gate.current = false; setBusy(false) }
  }
  return <aside ref={surface} className="dev-files" aria-label="Project files"><header><strong>Project files</strong><button className="dev-control" aria-label="Close project files" disabled={busy} onClick={onClose}><X size={16} /></button></header>
    {error && <p role="alert">{error}</p>}{status && <p role="status">{status}</p>}
    <div className="dev-files-body"><nav aria-label="File explorer"><div className="dev-files-location"><button className="dev-control" aria-label="Parent folder" disabled={!directory || busy} onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}><ArrowLeft size={15} /></button><span title={directory}>{directory || 'Workspace'}</span></div><input aria-label="Filter files in folder" placeholder="Filter this folder…" value={filter} onChange={event => setFilter(event.target.value)} />
      <details><summary>Search project</summary><form onSubmit={event => { event.preventDefault(); void search() }}><input aria-label="Search project text or filenames" placeholder="Text or filename…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /><button className="dev-control" disabled={searching || !query.trim()}>{searching ? 'Searching…' : 'Search'}</button></form>{matches?.map((match, index) => <button type="button" className="dev-file-entry" key={`${match.path}:${index}`} title={match.text ?? match.path} disabled={busy} onClick={() => void load(match.path, false, match.line)}><span>{match.path}{match.line ? `:${match.line}` : ''}{match.text && <small>{match.text}</small>}</span></button>)}{matches?.length === 0 && <small>No matches in searchable text files.</small>}{searchLimited && <small>Results limited. Refine your search; generated and large files are excluded.</small>}</details>
      <details><summary>New file</summary><form onSubmit={event => { event.preventDefault(); void create() }}><input aria-label="New filename" placeholder="filename.ts" value={newPath} onChange={event => setNewPath(event.target.value)} /><button className="dev-control" disabled={busy || locked || !newPath.trim()}>Create file</button></form></details>
      {listing ? <p role="status">Loading files…</p> : entries.filter(entry => entry.name.toLowerCase().includes(filter.toLowerCase())).map(entry => <button className="dev-file-entry" key={entry.path} disabled={busy} aria-current={file?.path === entry.path ? 'page' : undefined} title={entry.path} onClick={() => { if (entry.directory) { setDirectory(entry.path); setFilter('') } else void load(entry.path) }}>{entry.directory ? <Folder size={14} /> : <File size={14} />}<span>{entry.name}</span></button>)}
      {truncated && <p>Folder preview limited to 500 entries.</p>}<small>Generated dependencies, sensitive files and symbolic links are hidden.</small></nav>
      <section>{file ? <><div className="dev-file-title"><span title={file.path}>{file.path}{dirty ? ' · Unsaved' : ''}</span><button className="dev-control" disabled={busy} onClick={() => void load(file.path, true)}>{dirty ? 'Discard draft and reload' : 'Reload'}</button></div><DeveloperEditor key={revision} file={file.path} initial={text} line={line} onChange={change} onSelection={setSelection} workspace={workspace} onOpen={(path, line) => void load(path, false, line)} onSave={() => void save()} /><footer><button className="secondary" disabled={busy} onClick={attach}>{selection ? 'Attach selection' : 'Attach file'}</button><button className="primary" disabled={busy || locked || !dirty} onClick={() => void save()}>{busy ? 'Please wait…' : 'Save file'}</button></footer>{locked && <small>Stop running tasks before saving file changes.</small>}</> : <p>Choose a text file to inspect, edit or attach to your message.</p>}</section>
    </div>
  </aside>
}
