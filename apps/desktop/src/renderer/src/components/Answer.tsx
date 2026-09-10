import { memo, useState } from 'react'
import { answerHtml } from '../markdown.js'

// One answer, drawn from its own words. While a reply streams, the thread
// re-renders on every few characters; without this every older message in
// it would have its markdown parsed again each time, which is work that
// grows with the length of the conversation. Memoised on the text, an
// answer is parsed once and then left alone.

export const Answer = memo(function Answer({ text }: { text: string }) {
  const [error, setError] = useState('')
  return <><div className="bubble-msg-body" onClick={(event) => {
    const link = event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : null
    if (!link?.startsWith('engram-artifact:')) return
    event.preventDefault()
    event.stopPropagation()
    setError('')
    try {
      void window.engram.artifactReveal(decodeURIComponent(link.slice('engram-artifact:'.length)))
        .catch(() => setError('This output file is unavailable. Ask the comet to check it.'))
    } catch { setError('This output link is invalid.') }
  }} dangerouslySetInnerHTML={{ __html: answerHtml(text) }} />{error && <p role="alert">{error}</p>}</>
})
