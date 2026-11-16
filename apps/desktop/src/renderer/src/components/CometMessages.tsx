import { Clock } from 'lucide-react'
import { memo, useId, type CSSProperties, type ReactNode } from 'react'
import type { CometMessage } from '../lib/cometThreads.js'
import { answerWhole, laterFiles, linkedFiles, restatedAnswers } from '../markdown.js'
import { ChatFiles } from './AnswerFiles.js'
import { CometWork } from './CometWork.js'
import { StreamingAnswer } from './StreamingAnswer.js'
import { ErrorAnswer, isProviderError } from './ErrorAnswer.js'
import { UserMessage } from './ChatAttachment.js'
import { Thinking } from './Thinking.js'
import { displayTaskAnswer, threadLang, threadWords, type ThreadLang } from '../lib/threadLang.js'
import { sameTurn } from '../lib/sameTurn.js'
import { dividerBefore, dividerLabel } from '../lib/timeDivider.js'

const failed = (message: CometMessage) => !!message.error || (message.role === 'assistant' && isProviderError(message.text))

type TurnProps = { message: CometMessage; live: boolean; divider: string | null; lang: ThreadLang; anchor: string; work: readonly string[]; skipFiles: string; restated: boolean }

const MessageTurn = memo(function MessageTurn({ message: m, live, divider: label, lang, anchor, work, skipFiles, restated }: TurnProps) {
  const divider = label !== null && <div className="bubble-time-divider">{label}</div>
  if (m.role !== 'assistant') return <div className="bubble-turn">{divider}<div className={`bubble-msg user${m.scheduled ? ' scheduled' : ''}`}>
    {m.scheduled && <small className="bubble-scheduled" data-testid="bubble-scheduled"><Clock size={11} aria-hidden /> {threadWords(lang).scheduled}</small>}
    <UserMessage text={m.text} attachments={m.attachments} />
  </div></div>
  return <div className={`bubble-turn${m.streaming || live ? ' live' : ''}`}>
    {divider}
    <CometWork busy={live} lines={[...work]} lang={lang} />
    {failed(m)
      ? <div className="bubble-msg assistant error"><ErrorAnswer text={m.text} kind={m.errorKind} provider={m.provider} lang={lang} /></div>
      : m.text && !restated ? <div className={`bubble-msg assistant${m.checking ? ' checking' : ''}`} style={{ '--copy-anchor': `${anchor}-0` } as CSSProperties}>
          <StreamingAnswer text={answerWhole(displayTaskAnswer(m.text, lang))} done={!m.streaming} skipFiles={skipFiles} />
        </div> : null}
  </div>
}, sameTurn)

export function CometMessages({ firstKey = 0, messages, busy, status, since, workLines, keptWork, children }: {
  // Key of the first message, so a page put in front keeps every existing key.
  firstKey?: number
  messages: CometMessage[]
  busy: boolean
  status: string
  since?: number
  workLines: string[]
  keptWork: string[]
  // Cards waiting on the person sit under the answer.
  children?: ReactNode
}) {
  const lastAssistant = messages.reduce((found, message, index) => message.role === 'assistant' ? index : found, -1)
  const lang = threadLang(messages)
  // Each bubble gets its own anchor name so its copy control binds to it and not to the last bubble.
  const anchorBase = `--copy-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const dividers = dividerBefore(messages), now = new Date(), skips = laterFiles(messages), restated = restatedAnswers(messages)
  return <ChatFiles.Provider value={linkedFiles(messages)}>
    {messages.map((m, i) => {
      const live = i === lastAssistant && busy
      return <MessageTurn key={firstKey + i} message={m} live={live} divider={dividers[i] ? dividerLabel(m.at!, lang, now) : null} lang={lang} anchor={`${anchorBase}-${i}`}
        work={live ? workLines : m.work ?? (i === lastAssistant ? keptWork : [])} skipFiles={skips[i]!} restated={restated[i]!} />
    })}
    {busy && <div className="chat-status-line" data-testid="bots-typing"><Thinking label={status} since={since} testId="bots-thinking" total={threadWords(lang).total} /></div>}
    {children}
  </ChatFiles.Provider>
}
