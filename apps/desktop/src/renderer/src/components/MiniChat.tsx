import { ArrowUp, Square } from 'lucide-react'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { StreamingAnswer } from './StreamingAnswer.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, loadCometThread } from '../lib/cometThreadsLive.js'
import { pendingStatus } from '../lib/pendingStatus.js'
import { useStickToBottom } from '../lib/useStickToBottom.js'

// A conversation small enough to sit inside a Mission Control tile: the
// thread, what the comet is doing right now, and a composer - the same
// seat as the full view, so words typed here land in the same transcript
// and the same turn machinery. Opening the full view is the tile's job.
export function MiniChat({ botId }: { botId: string }) {
  useSyncExternalStore(cometThreads.subscribe, cometThreads.getSnapshot)
  const thread = cometThreads.thread(botId)
  const listRef = useRef<HTMLDivElement>(null)
  useStickToBottom(listRef, thread.messages)
  // A comet seated here may never have been opened in the full view, so its
  // words on disk have to be asked for before the tile can show them.
  useEffect(() => {
    if (!cometThreads.thread(botId).loaded) void loadCometThread(botId)
  }, [botId])
  const send = async (message: string) => {
    if (!message.trim() || thread.busy) return
    const history = cometThreads.begin(botId, message.trim())
    await api
      .chatSend({ engineId: '', message: message.trim(), history, channel: cometChannel(botId), botId })
      .catch(() => undefined)
  }
  const stop = () => {
    cometThreads.stop(botId, t('bubble.stopped'))
    void api.chatAbort(cometChannel(botId)).catch(() => undefined)
  }
  const status = thread.busy ? pendingStatus(t, thread.workLines[thread.workLines.length - 1]) : ''
  return (
    <div className="mini-chat" data-testid={`mini-chat-${botId}`}>
      <div className="mini-chat-thread" ref={listRef}>
        {thread.messages.length === 0 && thread.loaded && <p className="mini-chat-empty">{t('mission.waiting')}</p>}
        {thread.messages.slice(-12).map((m, i) => (
          <div key={i} className={`mini-msg ${m.role}`}>
            {m.role === 'assistant' ? <StreamingAnswer text={m.text} done={!m.streaming} /> : m.text}
          </div>
        ))}
        {thread.busy && <p className="mini-chat-status">{status}</p>}
      </div>
      <form
        className="mini-chat-write"
        onSubmit={(e) => {
          e.preventDefault()
          const box = e.currentTarget.elements.namedItem('say') as HTMLInputElement
          void send(box.value)
          box.value = ''
        }}
      >
        <input name="say" placeholder={t('mission.say')} disabled={thread.busy} autoComplete="off" />
        {thread.busy ? (
          <button type="button" className="mini-chat-stop" aria-label={t('bubble.stop')} onClick={stop}>
            <Square size={10} strokeWidth={2.5} aria-hidden />
          </button>
        ) : (
          <button type="submit" className="mini-chat-send" aria-label={t('chat.send')}>
            <ArrowUp size={13} aria-hidden />
          </button>
        )}
      </form>
    </div>
  )
}
