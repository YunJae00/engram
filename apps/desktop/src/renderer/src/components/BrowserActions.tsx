import { ArrowLeft, ArrowRight, Bookmark, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api.js'
import { useApp } from '../state.js'

export function BrowserActions({ lane, url, live }: { lane: string; url?: string; live: boolean }) {
  const { showToast } = useApp()
  const [history, setHistory] = useState({ back: false, forward: false })
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.bookmarksList>>>([])
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.bookmarksSources>>>([])
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
    void Promise.all([api.bookmarksList(), api.bookmarksSources()]).then(([items, profiles]) => {
      if (!stale) { setRows(items); setSources(profiles) }
    }).catch(report)
    const dismiss = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); box.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus() } }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', key)
    const resize = () => setOpen(false)
    window.addEventListener('resize', resize)
    return () => { stale = true; window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', key); window.removeEventListener('resize', resize) }
  }, [open])
  const navigate = async (direction: 'back' | 'forward' | 'reload') => {
    setBusy(true)
    try { await api.agentNavigate(lane, direction) } catch (error) { report(error) }
    finally { setBusy(false) }
  }
  const importFrom = async (id: string) => {
    setBusy(true)
    try { setRows(await api.bookmarksImport(id)); showToast('Bookmarks imported. Sign-ins and passwords were not copied.') }
    catch (error) { report(error) }
    finally { setBusy(false) }
  }
  const visible = rows.filter((row) => `${row.title} ${row.url} ${row.folder}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="browser-actions" ref={box}>
    <button className="live-dock-act" title="Back" aria-label="Back" disabled={busy || !history.back} onClick={() => void navigate('back')}><ArrowLeft size={14} /></button>
    <button className="live-dock-act" title="Forward" aria-label="Forward" disabled={busy || !history.forward} onClick={() => void navigate('forward')}><ArrowRight size={14} /></button>
    <button className="live-dock-act" data-testid="live-refresh" title="Reload page" aria-label="Reload page" disabled={busy || !live} onClick={() => void navigate('reload')}><RotateCw size={14} /></button>
    <button className="live-dock-act" title="Bookmarks" aria-label="Bookmarks" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}><Bookmark size={14} /></button>
    {open && createPortal(<div ref={menu} className="browser-bookmarks" role="dialog" aria-label="Bookmarks" style={{ right: Math.max(8, innerWidth - (box.current?.getBoundingClientRect().right ?? innerWidth)), top: Math.min(innerHeight - 200, (box.current?.getBoundingClientRect().bottom ?? 48) + 8) }}>
      <input autoFocus placeholder="Search bookmarks" aria-label="Search bookmarks" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="browser-bookmark-list">
        {visible.slice(0, 150).map((row) => <button key={row.url} title={`${row.folder}\n${row.url}`} onClick={() => { setOpen(false); void api.agentGo(row.url, lane).catch(report) }}><span>{row.title}</span><small>{new URL(row.url).hostname}</small></button>)}
        {!visible.length && <p>{rows.length ? 'No matches' : 'Import bookmarks from your browser.'}</p>}
        {visible.length > 150 && <p>Refine your search to see more.</p>}
      </div>
      <div className="browser-bookmark-import">
        <span>Import bookmarks only</span>
        {sources.map((source) => <button key={source.id} disabled={busy} onClick={() => void importFrom(source.id)}>{source.name}</button>)}
        {!sources.length && <small>No Chrome or Edge bookmarks found.</small>}
      </div>
    </div>, document.body)}
  </div>
}
