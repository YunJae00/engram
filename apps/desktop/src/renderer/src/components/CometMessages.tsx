import { Clock } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import type { CometMessage } from '../lib/cometThreads.js'
import { answerBubbles } from '../markdown.js'
import { CometWork } from './CometWork.js'
import { StreamingAnswer } from './StreamingAnswer.js'
import { CheckEvidence } from './CheckEvidence.js'
import { ErrorAnswer, isProviderError } from './ErrorAnswer.js'
import { UserMessage } from './ChatAttachment.js'
import { ReplyChips } from './ReplyChips.js'
import { Thinking } from './Thinking.js'
import { displayTaskAnswer, threadLang, threadWords } from '../lib/threadLang.js'

export function CometMessages({ messages, busy, status, since, workLines, keptWork, offerOpen = false, onReply, onResend, children }: {
  messages: CometMessage[]
  busy: boolean
  status: string
  since?: number
  workLines: string[]
  keptWork: string[]
  // A question card is already offering the next moves.
  offerOpen?: boolean
  onReply(label: string): void
  // Sends the last message again when it failed.
  onResend?(): void
  // Cards waiting on the person sit under the answer, above the replies.
  children?: ReactNode
}) {
  const lastAssistant = messages.reduce((found, message, index) => message.role === 'assistant' ? index : found, -1)
  const failed = (message: CometMessage) => !!message.error || (message.role === 'assistant' && isProviderError(message.text))
  const last = messages[lastAssistant]
  const lang = threadLang(messages)
  const resendable = !busy && !!onResend && messages.at(-1)?.error && messages.at(-2)?.role === 'user' && !messages.at(-2)?.attachments?.length
  return <>
    {messages.map((m, i) => {
      if (m.role !== 'assistant') return <div key={i} className={`bubble-msg user${m.scheduled ? ' scheduled' : ''}`}>
        {m.scheduled && <small className="bubble-scheduled" data-testid="bubble-scheduled"><Clock size={11} aria-hidden /> {threadWords(lang).scheduled}</small>}
        <UserMessage text={m.text} attachments={m.attachments} />
      </div>
      const live = i === lastAssistant && busy
      return <Fragment key={i}>
        <CometWork busy={live} lines={live ? workLines : m.work ?? (i === lastAssistant ? keptWork : [])} />
        {failed(m)
          ? <div className="bubble-msg assistant error"><ErrorAnswer text={m.text} kind={m.errorKind} provider={m.provider} lang={lang} {...(resendable && i === messages.length - 1 ? { onRetry: onResend } : {})} /></div>
          : m.text ? answerBubbles(displayTaskAnswer(m.text, lang)).map((part, k, parts) => (
            <div key={k} className={`bubble-msg assistant${m.checking ? ' checking' : ''}`}>
              <StreamingAnswer text={part} done={!m.streaming || k < parts.length - 1} />
              {k === parts.length - 1 && !m.streaming && m.evidence && <CheckEvidence evidence={m.evidence} lang={lang} />}
            </div>
          )) : null}
      </Fragment>
    })}
    {busy && <div className="chat-status-line" data-testid="bots-typing"><Thinking label={status} since={since} testId="bots-thinking" total={threadWords(lang).total} /></div>}
    {children}
    {!busy && !offerOpen && last && !last.streaming && !failed(last) && <ReplyChips text={last.text} onPick={onReply} />}
  </>
}
