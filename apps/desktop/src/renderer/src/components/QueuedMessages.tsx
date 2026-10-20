import { useSyncExternalStore } from 'react'
import { Send, X } from 'lucide-react'
import { api } from '../api.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { flushQueuedCometMessages, sendQueuedNow } from '../lib/attachments.js'
import { threadLang, threadT, threadWords } from '../lib/threadLang.js'

export function QueuedMessages({ botId }: { botId: string }) {
  const thread = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(botId))
  if (!thread.queued.length) return null
  const lang = threadLang(thread.messages)
  const words = threadWords(lang)
  return <section className="queued-messages" aria-label="Next messages" data-testid="queued-messages">
    <header><span>{thread.queueHeld ? words.paused : words.next} · {thread.queued.length}</span>
      {thread.queueHeld ? <button disabled={thread.busy} onClick={() => { cometThreads.resumeQueue(botId); void flushQueuedCometMessages(api, cometThreads, botId) }}>{words.sendNext}</button> : <small>{words.after}</small>}
    </header>
    <ol>{thread.queued.map(message => <li key={message.id}>
      <span>{message.draft || message.attachments.map(file => file.name).join(', ')}{message.draft && message.attachments.length > 0 && <small> · {message.attachments.length} files</small>}</span>
      {/* Cut in: the reply in progress stops where it is and this one is answered now. */}
      {thread.busy && <button className="queued-send-now" data-testid="queued-send-now" aria-label={`${words.sendNow}: ${message.draft || 'Files'}`} title={words.sendNow} onClick={() => void sendQueuedNow(api, cometThreads, botId, message.id, threadT(lang)('bubble.stopped'))}><Send size={13} aria-hidden /><span>{words.sendNow}</span></button>}
      <button aria-label={`Remove queued message: ${message.draft || 'Files'}`} onClick={() => cometThreads.removeQueued(botId, message.id)}><X size={14} aria-hidden /></button>
    </li>)}</ol>
    {thread.queued.length === 10 && <small>{words.full}</small>}
  </section>
}
