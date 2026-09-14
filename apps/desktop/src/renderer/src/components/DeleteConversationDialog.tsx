import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function DeleteConversationDialog({ name, count, kind, onClose, onDelete }: {
  name: string; count?: number; kind: 'chat' | 'routine'; onClose(): void; onDelete(contents: boolean): Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  const noun = kind === 'chat' ? 'conversation' : 'routine'
  const items = `${count} ${noun}${count === 1 ? '' : 's'}`
  useLayoutEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(onClose, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160)
    return () => clearTimeout(timer)
  }, [closing, onClose])
  const remove = async (contents: boolean) => {
    if (busy || closing) return
    setBusy(true)
    try { await onDelete(contents); setClosing(true) }
    catch { setError('Could not finish deleting. Any remaining items have been kept.'); setBusy(false) }
  }
  return createPortal(<dialog ref={dialog} className="delete-conversation-dialog" data-closing={closing} data-folder={count !== undefined && count > 0} aria-labelledby="delete-conversation-title" onCancel={event => { event.preventDefault(); if (!busy) setClosing(true) }}>
    <h2 id="delete-conversation-title">Delete {count === undefined ? noun : 'folder'}?</h2>
    <p className="delete-conversation-name">{name}</p>
    <p>{count === undefined ? `This removes the ${noun} from your library.` : `${items} in this folder. You can keep them in the sidebar or delete them too.`}</p>
    {error && <p role="alert">{error}</p>}
    <div className="delete-conversation-actions">
      <button className="secondary" autoFocus disabled={busy || closing} onClick={() => setClosing(true)}>Cancel</button>
      {count !== undefined && <button className="secondary" disabled={busy} onClick={() => void remove(false)}>Delete folder only</button>}
      {(count === undefined || count > 0) && <button className="danger" disabled={busy} onClick={() => void remove(true)}>{count === undefined ? `Delete ${noun}` : `Delete folder and ${items}`}</button>}
    </div>
  </dialog>, document.body)
}
