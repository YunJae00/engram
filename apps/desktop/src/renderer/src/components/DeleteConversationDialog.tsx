import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

export function DeleteConversationDialog({ name, count, kind, summaryId, onClose, onDelete }: {
  name: string; count?: number; kind: 'chat' | 'routine'; summaryId?: string; onClose(): void; onDelete(contents: boolean): Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  const [summary, setSummary] = useState<{ routines: number; facts: number; archivedChats: number } | null>(null)
  useEffect(() => {
    if (!summaryId) return
    let live = true
    setSummary(null); setError('')
    window.engram.botDeleteSummary(summaryId).then(next => { if (live) setSummary(next) }, failure => { if (live) setError(String((failure as Error).message ?? failure)) })
    return () => { live = false }
  }, [summaryId])
  // A bot delete stays disabled until its counts are known.
  const blocked = summaryId !== undefined && !summary
  const close = useRef(onClose)
  useLayoutEffect(() => { close.current = onClose }, [onClose])
  const noun = kind === 'chat' ? 'conversation' : 'routine'
  const items = `${count} ${noun}${count === 1 ? '' : 's'}`
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => close.current(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160)
    return () => clearTimeout(timer)
  }, [closing])
  const remove = async (contents: boolean) => {
    if (busy || closing || blocked) return
    setBusy(true)
    try { await onDelete(contents); setClosing(true) }
    catch { setError('Could not finish deleting. Any remaining items have been kept.'); setBusy(false) }
  }
  return createPortal(<dialog ref={dialog} className="delete-conversation-dialog" data-closing={closing} data-folder={count !== undefined && count > 0} aria-labelledby="delete-conversation-title" onCancel={event => { event.preventDefault(); if (!busy) setClosing(true) }}>
    <h2 id="delete-conversation-title">Delete {count === undefined ? noun : 'folder'}?</h2>
    <p className="delete-conversation-name">{name}</p>
    <p>{count === undefined ? `This removes the ${noun} from your library.` : `${items} in this folder. You can keep them in the sidebar or delete them too.`}</p>
    {summaryId && (summary ? <>
      <ul className="delete-summary">
        <li data-testid="delete-summary-routines" data-count={summary.routines}>{plural(summary.routines, 'routine')}</li>
        <li data-testid="delete-summary-facts" data-count={summary.facts}>{plural(summary.facts, 'remembered fact')}</li>
        <li data-testid="delete-summary-archived" data-count={summary.archivedChats}>{plural(summary.archivedChats, 'archived chat')}</li>
      </ul>
      <p>Routines and remembered facts are deleted with the bot. Archived chats stay on disk.</p>
    </> : !error && <p>Counting what goes with this bot…</p>)}
    {error && <p role="alert">{error}</p>}
    <div className="delete-conversation-actions">
      <button className="secondary" autoFocus disabled={busy || closing} onClick={() => setClosing(true)}>Cancel</button>
      {count !== undefined && <button className="secondary" disabled={busy} onClick={() => void remove(false)}>Delete folder only</button>}
      {(count === undefined || count > 0) && <button className="danger" disabled={busy || blocked} onClick={() => void remove(true)}>{count === undefined ? `Delete ${noun}` : `Delete folder and ${items}`}</button>}
    </div>
  </dialog>, document.body)
}
