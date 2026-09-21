import { useState } from 'react'
import { Pencil, Play, X } from 'lucide-react'
import type { DevQueuedMessage } from '../../../shared/developers.js'
import { api, apiErrorText } from '../api.js'

export function DeveloperQueue({ sessionId, messages }: { sessionId: string; messages: DevQueuedMessage[] }) {
  const [editing, setEditing] = useState(''), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const update = async (id: string, action: 'remove' | 'resume' | 'edit') => {
    if (busy) return
    setBusy(true); setError('')
    try { await api.devQueued(sessionId, id, action, action === 'edit' ? text : undefined); setEditing('') }
    catch (error) { setError(apiErrorText((error as Error).message)) }
    finally { setBusy(false) }
  }
  if (!messages.length) return null
  return <section className="dev-queue" aria-label="Queued messages"><small>Next messages · {messages.length}</small>
    {messages.map(message => <div className="dev-queued" key={message.id}>
      {editing === message.id ? <form onSubmit={event => { event.preventDefault(); void update(message.id, 'edit') }}><textarea aria-label="Edit queued message" value={text} onChange={event => setText(event.target.value)} maxLength={100_000} /><button className="dev-control" disabled={busy || !text.trim()}>Save</button><button type="button" className="dev-control" onClick={() => setEditing('')}>Cancel</button></form> : <><span title={message.text}>{message.text}<small>{message.state === 'uncertain' ? 'Delivery unconfirmed — review before sending again' : message.state === 'paused' ? 'Paused — resume when ready' : message.state === 'sending' ? 'Sending…' : 'Queued for the next turn'}</small></span>
        {message.state === 'paused' && <button className="dev-control" aria-label="Resume queued message" disabled={busy} onClick={() => void update(message.id, 'resume')}><Play size={13} /></button>}
        <button className="dev-control" aria-label="Edit queued message" disabled={busy || message.state === 'sending' || message.state === 'uncertain'} onClick={() => { setEditing(message.id); setText(message.text) }}><Pencil size={13} /></button>
        <button className="dev-control" aria-label="Remove queued message" disabled={busy || message.state === 'sending'} onClick={() => void update(message.id, 'remove')}><X size={13} /></button>
      </>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>
}
