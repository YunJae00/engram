import { ArrowLeft, ArrowRight, Bookmark, LoaderCircle, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api.js'
import { useApp } from '../state.js'
import { BookmarkImport } from './BookmarkImport.js'
import { BookmarkList } from './BookmarkList.js'

export function BrowserActions({ lane, url, live }: { lane: string; url?: string; live: boolean }) {
  const { showToast } = useApp()
  const [history, setHistory] = useState({ back: false, forward: false })
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.bookmarksList>>>([])
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.bookmarksSources>>>([])
  const [sourcesLoaded, setSourcesLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [receipt, setReceipt] = useState('')
  const [source, setSource] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const report = (error: unknown) => showToast(error instanceof Error ? error.message : 'Could not complete the browser action')
  useEffect(() => {
    let stale = false
    setHistory({ back: false, forward: false })
    if (live) void api.agentHistory(lane).then((value) => { if (!stale) setHistory(value) }).catch(() => {})
    return () => { stale = true }
  }, [lane, url, live, busy])
  useEffect(() => {
    if (!open) return
    let stale = false
    setSourcesLoaded(false)
    setLoading(true); setError('')
    void api.bookmarksList().then(items => { if (!stale) setRows(items) }).catch(() => { if (!stale) setError('Could not load saved bookmarks. Try again.') }).finally(() => { if (!stale) setLoading(false) })
    void api.bookmarksSources().then(profiles => { if (!stale) { setSources(profiles); setSourcesLoaded(true) } }).catch(() => { if (!stale) setError('Could not read browser profiles. Try again.') })
    const dismiss = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); box.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus() } }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', key)
    const resize = () => setOpen(false)
    window.addEventListener('resize', resize)
    return () => { stale = true; window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', key); window.removeEventListener('resize', resize) }
  }, [open, attempt])
  const navigate = async (direction: 'back' | 'forward' | 'reload') => {
    setBusy(true)
    try { await api.agentNavigate(lane, direction) } catch (error) { report(error) }
    finally { setBusy(false) }
  }
  const importFrom = async (id: string) => {
    setBusy(true)
    try { const items = await api.bookmarksImport(id); setRows(items); setQuery(''); setSource(id); setReceipt(`${items.filter(row => row.sourceId === id).length || items.length} bookmarks available · Import complete`) }
    finally { setBusy(false) }
  }
  const profiles = [...new Map(rows.map(row => [row.sourceId ?? 'legacy', row.sourceName ?? 'Previously imported'])).entries()]
  const selectedSource = profiles.some(([id]) => id === source) ? source : ''
  const visible = rows.filter(row => (!selectedSource || (row.sourceId ?? 'legacy') === selectedSource) && `${row.title} ${row.url} ${row.folder} ${row.sourceName ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="browser-actions" ref={box}>
    <button className="live-dock-act" title="Back" aria-label="Back" disabled={busy || !history.back} onClick={() => void navigate('back')}><ArrowLeft size={14} /></button>
    <button className="live-dock-act" title="Forward" aria-label="Forward" disabled={busy || !history.forward} onClick={() => void navigate('forward')}><ArrowRight size={14} /></button>
    <button className="live-dock-act" data-testid="live-refresh" title="Reload page" aria-label="Reload page" disabled={busy || !live} onClick={() => void navigate('reload')}><RotateCw size={14} /></button>
    <button className="live-dock-act" title="Bookmarks" aria-label="Bookmarks" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}><Bookmark size={14} /></button>
    {open && createPortal(<div ref={menu} className="browser-bookmarks" role="dialog" aria-label="Bookmarks" style={{ right: Math.max(8, innerWidth - (box.current?.getBoundingClientRect().right ?? innerWidth)), top: Math.min(innerHeight - 200, (box.current?.getBoundingClientRect().bottom ?? 48) + 8) }}>
      <input autoFocus placeholder="Search bookmarks" aria-label="Search bookmarks" value={query} onChange={(event) => setQuery(event.target.value)} />
      {profiles.length > 0 && <select aria-label="Bookmark source" value={profiles.some(([id]) => id === source) ? source : ''} onChange={event => setSource(event.target.value)}><option value="">All profiles</option>{profiles.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>}
      {receipt && <p role="status">{receipt}</p>}
      {loading && <p className="inline-loading" role="status"><LoaderCircle size={14} className="computer-spinner" aria-hidden />Loading bookmarks…</p>}
      {!sourcesLoaded && !error && <p className="inline-loading" role="status"><LoaderCircle size={14} className="computer-spinner" aria-hidden />Finding browser profiles and managed bookmarks…</p>}
      {error && <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
      <div className="browser-bookmark-list">
        <BookmarkList rows={visible} search={query} onOpen={url => { setOpen(false); void api.agentGo(url, lane).catch(report) }} />
        {!visible.length && !loading && !error && <p>{rows.length ? 'No matches' : 'Import bookmarks from your browser.'}</p>}
      </div>
      <div className="browser-bookmark-import">
        <button disabled={busy || !sourcesLoaded} onClick={() => { setOpen(false); setImporting(true) }}>Import bookmarks…</button>
      </div>
    </div>, document.body)}
    {importing && <BookmarkImport sources={sources} onImport={importFrom} onClose={imported => { setImporting(false); if (imported) setOpen(true); else box.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus() }} />}
  </div>
}
