import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { api } from '../api.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { flushQueuedCometMessages } from '../lib/attachments.js'

export function QueuedMessages({ botId }: { botId: string }) {
  const thread = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(botId))
  if (!thread.queued.length) return null
  return <section className="queued-messages" aria-label="Next messages" data-testid="queued-messages">
    <header><span>{thread.queueHeld ? 'Paused' : 'Next'} · {thread.queued.length}</span>
      {thread.queueHeld ? <button disabled={thread.busy} onClick={() => { cometThreads.resumeQueue(botId); void flushQueuedCometMessages(api, cometThreads, botId) }}>Send next</button> : <small>Sends after this reply</small>}
    </header>
    <ol>{thread.queued.map(message => <li key={message.id}>
      <span>{message.draft || message.attachments.map(file => file.name).join(', ')}{message.draft && message.attachments.length > 0 && <small> · {message.attachments.length} files</small>}</span>
      <button aria-label={`Remove queued message: ${message.draft || 'Files'}`} onClick={() => cometThreads.removeQueued(botId, message.id)}><X size={14} aria-hidden /></button>
    </li>)}</ol>
    {thread.queued.length === 10 && <small>Queue full. Remove a message or wait for a reply.</small>}
  </section>
}
