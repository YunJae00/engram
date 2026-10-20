import { Clock } from 'lucide-react'
import { Fragment } from 'react'
import type { CometMessage } from '../lib/cometThreads.js'
import { answerBubbles } from '../markdown.js'
import { CometWork } from './CometWork.js'
import { StreamingAnswer } from './StreamingAnswer.js'
import { CheckEvidence } from './CheckEvidence.js'
import { ErrorAnswer, isProviderError } from './ErrorAnswer.js'
import { UserMessage } from './ChatAttachment.js'
import { ReplyChips } from './ReplyChips.js'
import { Thinking } from './Thinking.js'
import { threadLang, threadWords } from '../lib/threadLang.js'

// One conversation, read the way a chat with an assistant reads: the
// person's words on the right; the comet's words, each turn's work card and
// its answer as short bubbles on the left; while it works, one typing bubble
// at the foot that says what it is doing; and, when it is done, the replies
// the person is likely to send next. The full view and the split tiles both
// show a conversation through this, so they never drift apart.
export function CometMessages({ messages, busy, status, since, workLines, keptWork, offerOpen = false, onReply }: {
  messages: CometMessage[]
  busy: boolean
  status: string
  since?: number
  workLines: string[]
  keptWork: string[]
  // A question card is already offering the next moves.
  offerOpen?: boolean
  onReply(label: string): void
}) {
  const lastAssistant = messages.reduce((found, message, index) => message.role === 'assistant' ? index : found, -1)
  const failed = (message: CometMessage) => !!message.error || (message.role === 'assistant' && isProviderError(message.text))
  const last = messages[lastAssistant]
  const lang = threadLang(messages)
  return <>
    {messages.map((m, i) => {
      if (m.role !== 'assistant') return <div key={i} className={`bubble-msg user${m.scheduled ? ' scheduled' : ''}`}>
        {m.scheduled && <small className="bubble-scheduled" data-testid="bubble-scheduled"><Clock size={11} aria-hidden /> {threadWords(lang).scheduled}</small>}
        <UserMessage text={m.text} attachments={m.attachments} />
      </div>
      const live = i === lastAssistant && busy
      return <Fragment key={i}>
        <CometWork busy={live} lang={lang} lines={live ? workLines : m.work ?? (i === lastAssistant ? keptWork : [])} />
        {failed(m)
          ? <div className="bubble-msg assistant error"><ErrorAnswer text={m.text} /></div>
          : m.text ? answerBubbles(m.text).map((part, k, parts) => (
            <div key={k} className={`bubble-msg assistant${m.checking ? ' checking' : ''}`}>
              <StreamingAnswer text={part} done={!m.streaming || k < parts.length - 1} />
              {k === parts.length - 1 && !m.streaming && m.evidence && <CheckEvidence evidence={m.evidence} />}
            </div>
          )) : null}
      </Fragment>
    })}
    {busy && <div className="bubble-typing" data-testid="bots-typing"><Thinking label={status} since={since} testId="bots-thinking" total={threadWords(lang).total} /></div>}
    {!busy && !offerOpen && last && !last.streaming && !failed(last) && <ReplyChips text={last.text} onPick={onReply} />}
  </>
}
