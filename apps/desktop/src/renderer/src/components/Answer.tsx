import { memo } from 'react'
import { answerHtml } from '../markdown.js'

// One answer, drawn from its own words. While a reply streams, the thread
// re-renders on every few characters; without this every older message in
// it would have its markdown parsed again each time, which is work that
// grows with the length of the conversation. Memoised on the text, an
// answer is parsed once and then left alone.

export const Answer = memo(function Answer({ text }: { text: string }) {
  return <div className="bubble-msg-body" dangerouslySetInnerHTML={{ __html: answerHtml(text) }} />
})
