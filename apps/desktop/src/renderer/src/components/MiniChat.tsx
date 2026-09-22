import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { StreamingAnswer } from './StreamingAnswer.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, loadCometThread } from '../lib/cometThreadsLive.js'
import { pendingStatus } from '../lib/pendingStatus.js'
import { useStickToBottom } from '../lib/useStickToBottom.js'
import { sendCometMessage } from '../lib/attachments.js'
import { RoutineProgress } from './RoutineProgress.js'
import { SubmitGate } from './SubmitGate.js'
import { PressGate } from './PressGate.js'
import { ChatComposer } from './ChatComposer.js'
import { ModelPicker } from './ModelPicker.js'
import { Globe } from 'lucide-react'
import { Thinking } from './Thinking.js'
import { UserMessage } from './ChatAttachment.js'
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
    if ((!message.trim() && !thread.attachments.length) || thread.busy) return
    await sendCometMessage(api, cometThreads, botId, message.trim(), thread.attachments)
  }
  const stop = () => {
    cometThreads.stop(botId, t('bubble.stopped'))
    void api.chatAbort(cometChannel(botId)).catch(() => undefined)
  }
  const status = thread.busy ? pendingStatus(t, thread.workLines[thread.workLines.length - 1]) : ''
  return (
    <div className="mini-chat" data-testid={`mini-chat-${botId}`}>
      <div className="mini-chat-thread conversation-thread" ref={listRef}>
        {thread.messages.length === 0 && thread.loaded && <p className="mini-chat-empty">{t('mission.waiting')}</p>}
        {thread.messages.map((m, i) => (
          <div key={i} className={`mini-msg ${m.role}`}>
            {m.role === 'assistant' ? (m.text.trim() && <StreamingAnswer text={m.text} done={!m.streaming} />) : <UserMessage text={m.text} attachments={m.attachments} />}
          </div>
        ))}
        {thread.busy && <Thinking label={status} since={thread.startedAt ?? undefined} />}
      </div>
      <div className="mini-chat-gates"><RoutineProgress channel={cometChannel(botId)} /><SubmitGate channel={cometChannel(botId)} /><PressGate channel={cometChannel(botId)} /></div>
      <RoutineLearning key={botId} botId={botId} working={thread.busy} />
      <RoutineSkillHint value={draft} select={() => { setDraft('/routine'); cometThreads.setDraft(botId, '/routine') }} />
      <div className="mini-chat-write"><ChatComposer value={draft} placeholder={t('mission.say')} maxLength={2000} busy={thread.busy} testId={`mini-input-${botId}`} attachments={thread.attachments} onAttachmentsChange={next => cometThreads.setAttachments(botId, next)} onChange={value => { setDraft(value); cometThreads.setDraft(botId, value) }} onSend={() => void send(draft)} onStop={stop} tools={<><button className="composer-web" aria-label={webOpen ? 'Hide website' : 'Show website'} aria-pressed={webOpen} onClick={onToggleWeb}><Globe size={15} aria-hidden /></button><ModelPicker scope={cometChannel(botId)} /></>} /></div>
    </div>
  )
}
