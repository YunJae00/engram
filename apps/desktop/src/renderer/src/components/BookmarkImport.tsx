import { Globe, LoaderCircle } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function BookmarkImport({ sources, onImport, onClose }: {
  sources: { id: string; name: string }[]; onImport(id: string): Promise<void>; onClose(imported: boolean): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [selected, setSelected] = useState(sources[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  const imported = useRef(false)
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose }, [onClose])
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => { dialog.current?.close(); close.current(imported.current) }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160)
    return () => clearTimeout(timer)
  }, [closing])
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  const submit = async () => {
    if (busy || closing || !selected) return
    setBusy(true)
    setError('')
    try { await onImport(selected); imported.current = true; setClosing(true) }
    catch (cause) {
      // Strip Electron's "Error invoking remote method 'x': Error:" wrapper so
      // the person sees the plain reason, not the IPC plumbing.
      const raw = cause instanceof Error ? cause.message : 'Could not import bookmarks.'
      setError(raw.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, ''))
      setBusy(false)
    }
  }
  return createPortal(<dialog ref={dialog} className="delete-conversation-dialog bookmark-import-dialog" data-closing={closing} aria-labelledby="bookmark-import-title" onCancel={event => { event.preventDefault(); if (!busy) setClosing(true) }}>
    <h2 id="bookmark-import-title">Import bookmarks</h2>
    <p>Choose a browser profile or organization collection. Folders stay organized; passwords and sign-ins are not copied.</p>
    <label htmlFor="bookmark-profile">Browser profile</label>
    <div className="bookmark-profile"><Globe size={22} aria-hidden /><select id="bookmark-profile" value={selected} disabled={busy || !sources.length} onChange={event => setSelected(event.target.value)}>{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}{!sources.length && <option value="">No browser profiles found</option>}</select></div>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><button className="secondary" disabled={busy || closing} onClick={() => setClosing(true)}>Cancel</button><button className="primary" disabled={busy || closing || !selected} onClick={() => void submit()}>{busy && <LoaderCircle size={15} className="computer-spinner" aria-hidden />}{busy ? 'Importing…' : 'Import'}</button></div>
  </dialog>, document.body)
}
