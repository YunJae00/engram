import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, loadCometThread } from '../lib/cometThreadsLive.js'
import { pendingStatus } from '../lib/pendingStatus.js'
import { threadLang, threadT } from '../lib/threadLang.js'
import { useStickToBottom } from '../lib/useStickToBottom.js'
import { sendCometMessage } from '../lib/attachments.js'
import { ThreadAsks } from './ThreadAsks.js'
import { ThreadOffers } from './ThreadOffers.js'
import { ScheduledChip } from './ScheduledChip.js'
import { ChatComposer } from './ChatComposer.js'
import { QueuedMessages } from './QueuedMessages.js'
import { ModelPicker } from './ModelPicker.js'
import { Globe } from 'lucide-react'
import { CometMessages } from './CometMessages.js'
import { RoutineLearning, RoutineSkillHint } from './RoutineLearning.js'

// A conversation small enough to sit inside a parallel tile: the
// thread, what the comet is doing right now, and a composer - the same
// seat as the full view, so words typed here land in the same transcript
// and the same turn machinery. Opening the full view is the tile's job.
export function MiniChat({ botId, webOpen, onToggleWeb }: { botId: string; webOpen: boolean; onToggleWeb(): void }) {
  const thread = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(botId))
  const [draft, setDraft] = useState(thread.draft)
  useEffect(() => setDraft(thread.draft), [thread.draft, thread.busy])
  const listRef = useRef<HTMLDivElement>(null)
  useStickToBottom(listRef, thread.messages, botId)
  // A comet seated here may never have been opened in the full view, so its
  // words on disk have to be asked for before the tile can show them.
  useEffect(() => {
    if (!cometThreads.thread(botId).loaded) void loadCometThread(botId).catch(() => undefined)
  }, [botId])
  const send = async (message: string) => {
    if ((!message.trim() && !thread.attachments.length) || thread.queued.length >= 10) return
    await sendCometMessage(api, cometThreads, botId, message.trim(), thread.attachments)
  }
  const stop = () => {
    cometThreads.stop(botId, t('bubble.stopped'))
    void api.chatAbort(cometChannel(botId)).catch(() => undefined)
  }
  const status = thread.busy ? pendingStatus(threadT(threadLang(thread.messages)), thread.awaitingModel ? undefined : thread.workLines[thread.workLines.length - 1]) : ''
  return (
    <div className="mini-chat" data-testid={`mini-chat-${botId}`}>
      <div className="mini-chat-thread conversation-thread" ref={listRef}>
        {thread.messages.length === 0 && thread.loaded && <p className="mini-chat-empty">{t('mission.waiting')}</p>}
        <CometMessages messages={thread.messages} busy={thread.busy} status={status} since={thread.startedAt ?? undefined} workLines={thread.workLines} keptWork={thread.keptWork} offerOpen={!!thread.offer} onReply={(label) => void send(label)} />
        <ThreadOffers botId={botId} onSend={(label) => void send(label)} />
        <ThreadAsks botId={botId} questionShown={!thread.busy && thread.messages.at(-1)?.role === 'assistant' && !thread.messages.at(-1)?.streaming ? thread.messages.at(-1)?.text : undefined} />
      </div>
      <div className="mini-chat-gates"><ScheduledChip botId={botId} /></div>
      <RoutineLearning key={botId} botId={botId} working={thread.busy} />
      <RoutineSkillHint value={draft} select={() => { setDraft('/routine'); cometThreads.setDraft(botId, '/routine') }} />
      <QueuedMessages botId={botId} />
      <div className="mini-chat-write"><ChatComposer value={draft} placeholder={t('mission.say')} maxLength={2000} busy={thread.busy} canQueue disabled={thread.queued.length >= 10} testId={`mini-input-${botId}`} attachments={thread.attachments} onAttachmentsChange={next => cometThreads.setAttachments(botId, next)} onChange={value => { setDraft(value); cometThreads.setDraft(botId, value) }} onSend={() => void send(draft)} onStop={stop} actions={<button className="composer-web" aria-label={webOpen ? 'Hide website' : 'Show website'} aria-pressed={webOpen} onClick={onToggleWeb}><Globe size={15} aria-hidden /><span>{webOpen ? 'Hide website' : 'Show website'}</span></button>} tools={<ModelPicker scope={cometChannel(botId)} />} /></div>
    </div>
  )
}
