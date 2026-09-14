import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function DeleteConversationDialog({ name, count, kind, onClose, onDelete }: {
  name: string; count?: number; kind: 'chat' | 'routine'; onClose(): void; onDelete(contents: boolean): Promise<void>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const noun = kind === 'chat' ? 'conversation' : 'routine'
  const items = `${count} ${noun}${count === 1 ? '' : 's'}`
  useEffect(() => { dialog.current?.showModal() }, [])
  const remove = async (contents: boolean) => {
    if (busy) return
    setBusy(true)
    try { await onDelete(contents); onClose() }
    catch { setError('Could not finish deleting. Any remaining items have been kept.'); setBusy(false) }
  }
  return createPortal(<dialog ref={dialog} className="delete-conversation-dialog" aria-labelledby="delete-conversation-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <h2 id="delete-conversation-title">Delete {count === undefined ? noun : 'folder'}?</h2>
    <p className="delete-conversation-name">{name}</p>
    <p>{count === undefined ? `This removes the ${noun} from your library.` : `${items} in this folder. You can keep them in the sidebar or delete them too.`}</p>
    {error && <p role="alert">{error}</p>}
    <div className="delete-conversation-actions">
      <button className="secondary" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
      {count !== undefined && <button className="secondary" disabled={busy} onClick={() => void remove(false)}>Delete folder only</button>}
      {(count === undefined || count > 0) && <button className="danger" disabled={busy} onClick={() => void remove(true)}>{count === undefined ? `Delete ${noun}` : `Delete folder and ${items}`}</button>}
    </div>
  </dialog>, document.body)
}
