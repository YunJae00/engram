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

// Full and split views share the same turn rendering.
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
  return <>
    {messages.map((m, i) => {
      if (m.role !== 'assistant') return <div key={i} className="bubble-msg user"><UserMessage text={m.text} attachments={m.attachments} /></div>
      const live = i === lastAssistant && busy
      return <Fragment key={i}>
        <CometWork busy={live} lines={live ? workLines : m.work ?? (i === lastAssistant ? keptWork : [])} />
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
    {busy && <div className="bubble-typing" data-testid="bots-typing"><Thinking label={status} since={since} testId="bots-thinking" /></div>}
    {!busy && !offerOpen && last && !last.streaming && !failed(last) && <ReplyChips text={last.text} onPick={onReply} />}
  </>
}
