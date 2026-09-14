import { Globe } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function BookmarkImport({ sources, onImport, onClose }: {
  sources: { id: string; name: string }[]; onImport(id: string): Promise<void>; onClose(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState(sources[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose }, [onClose])
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => { dialog.current?.close(); close.current() }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160)
    return () => clearTimeout(timer)
  }, [closing])
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  const submit = async () => {
    if (busy || closing || !selected) return
    setBusy(true)
    try { await onImport(selected); setClosing(true) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not import bookmarks.'); setBusy(false) }
  }
  return createPortal(<dialog ref={dialog} className="delete-conversation-dialog bookmark-import-dialog" data-closing={closing} aria-labelledby="bookmark-import-title" onCancel={event => { event.preventDefault(); if (!busy) setClosing(true) }}>
    <h2 id="bookmark-import-title">Import bookmarks</h2>
    <p>Choose a browser profile. Only bookmarks are copied, not passwords or sign-ins.</p>
    <label htmlFor="bookmark-profile">Browser profile</label>
    <div className="bookmark-profile"><Globe size={22} aria-hidden /><select id="bookmark-profile" value={selected} disabled={busy || !sources.length} onChange={event => setSelected(event.target.value)}>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}{!sources.length && <option value="">No browser profiles found</option>}</select></div>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><button className="secondary" disabled={busy || closing} onClick={() => setClosing(true)}>Cancel</button><button className="primary" disabled={busy || closing || !selected} onClick={() => void submit()}>{busy ? 'Importing…' : 'Import'}</button></div>
  </dialog>, document.body)
}
