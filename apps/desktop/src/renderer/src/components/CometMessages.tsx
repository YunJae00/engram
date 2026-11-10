import { Clock } from 'lucide-react'
import { useId, type CSSProperties, type ReactNode } from 'react'
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
import { dividerBefore, dividerLabel } from '../lib/timeDivider.js'

export function CometMessages({ firstKey = 0, messages, busy, status, since, workLines, keptWork, offerOpen = false, onReply, onResend, children }: {
  // Key of the first message, so a page put in front keeps every existing key.
  firstKey?: number
  messages: CometMessage[]
  busy: boolean
  status: string
  since?: number
  workLines: string[]
  keptWork: string[]
  // A question card is already offering the next moves.
  offerOpen?: boolean
  onReply(label: string): boolean
  // Sends the last message again when it failed.
  onResend?(): void
  // Cards waiting on the person sit under the answer, above the replies.
  children?: ReactNode
}) {
  const lastAssistant = messages.reduce((found, message, index) => message.role === 'assistant' ? index : found, -1)
  const failed = (message: CometMessage) => !!message.error || (message.role === 'assistant' && isProviderError(message.text))
  // An empty placeholder from background work must not tear down the chips under a pending click.
  let settledIndex = messages.length - 1
  while (settledIndex >= 0 && messages[settledIndex]!.role === 'assistant' && messages[settledIndex]!.streaming && !messages[settledIndex]!.text) settledIndex--
  const settled = messages[settledIndex]
  const lang = threadLang(messages)
  // Each bubble gets its own anchor name so its copy control binds to it and not to the last bubble.
  const anchorBase = `--copy-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const dividers = dividerBefore(messages), now = new Date()
  const resendable = !busy && !!onResend && messages.at(-1)?.error && messages.at(-2)?.role === 'user' && !messages.at(-2)?.attachments?.length
  return <>
    {messages.map((m, i) => {
      const divider = dividers[i] && <div className="bubble-time-divider">{dividerLabel(m.at!, lang, now)}</div>
      if (m.role !== 'assistant') return <div key={firstKey + i} className="bubble-turn">{divider}<div className={`bubble-msg user${m.scheduled ? ' scheduled' : ''}`}>
        {m.scheduled && <small className="bubble-scheduled" data-testid="bubble-scheduled"><Clock size={11} aria-hidden /> {threadWords(lang).scheduled}</small>}
        <UserMessage text={m.text} attachments={m.attachments} />
      </div></div>
      const live = i === lastAssistant && busy
      return <div key={firstKey + i} className={`bubble-turn${m.streaming || live ? ' live' : ''}`}>
        {divider}
        <CometWork busy={live} lines={live ? workLines : m.work ?? (i === lastAssistant ? keptWork : [])} />
        {failed(m)
          ? <div className="bubble-msg assistant error"><ErrorAnswer text={m.text} kind={m.errorKind} provider={m.provider} lang={lang} {...(resendable && i === messages.length - 1 ? { onRetry: onResend } : {})} /></div>
          : m.text ? answerBubbles(displayTaskAnswer(m.text, lang)).map((part, k, parts) => (
            <div key={k} className={`bubble-msg assistant${m.checking ? ' checking' : ''}`} style={{ '--copy-anchor': `${anchorBase}-${i}-${k}` } as CSSProperties}>
              <StreamingAnswer text={part} done={!m.streaming || k < parts.length - 1} />
              {k === parts.length - 1 && !m.streaming && m.evidence && <CheckEvidence evidence={m.evidence} lang={lang} />}
            </div>
          )) : null}
      </div>
    })}
    {busy && <div className="chat-status-line" data-testid="bots-typing"><Thinking label={status} since={since} testId="bots-thinking" total={threadWords(lang).total} /></div>}
    {children}
    {settled?.role === 'assistant' && !settled.streaming && !settled.progress && !failed(settled) && <ReplyChips key={`chips-${firstKey + settledIndex}-${settled.text}`} text={settled.text} hidden={busy || offerOpen} onPick={onReply} />}
  </>
}
