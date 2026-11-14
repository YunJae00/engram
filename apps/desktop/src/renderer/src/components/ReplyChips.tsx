import { useRef } from 'react'
import { suggestedReplies } from '../markdown.js'
import type { ThreadLang } from '../lib/threadLang.js'

// The next things the person is likely to say, offered as buttons under the
// last answer. A tap sends the words as their own message.
export function ReplyChips({ text, lang, hidden = false, onPick }: { text: string; lang?: ThreadLang; hidden?: boolean; onPick: (label: string) => boolean }) {
  const replies = suggestedReplies(text, lang)
  // One answer takes one tap; a tap that could not send stays retryable.
  const used = useRef<string | null>(null)
  const pick = (label: string) => {
    if (used.current === text) return
    if (onPick(label)) used.current = text
  }
  return <div className="reply-chips" hidden={hidden} data-testid="reply-chips" aria-label="Suggested replies">
    {replies.map((label, index) => <button key={`${index}-${label}`} type="button" className="reply-chip" data-testid={`reply-chip-${index}`} onClick={() => pick(label)}>{label}</button>)}
  </div>
}
