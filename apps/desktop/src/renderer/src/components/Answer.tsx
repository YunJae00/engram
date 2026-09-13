import { memo, useState } from 'react'
import { answerHtml } from '../markdown.js'
import { Copy, Check } from 'lucide-react'
import { answerSites, SiteIcon } from './SiteIcon.js'

// One answer, drawn from its own words. While a reply streams, the thread
// re-renders on every few characters; without this every older message in
// it would have its markdown parsed again each time, which is work that
// grows with the length of the conversation. Memoised on the text, an
// answer is parsed once and then left alone.

export const Answer = memo(function Answer({ text, compact = false }: { text: string; compact?: boolean }) {
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const sites = compact ? [] : answerSites(text)
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(() => { setCopied(true); setError('') }).catch(() => setError('Could not copy. Select the text and copy it manually.'))
  }
  return <><div className="bubble-msg-body" onClick={(event) => {
    const codeButton = event.target instanceof Element ? event.target.closest('[data-copy-code]') : null
    if (codeButton) { copy(codeButton.closest('.answer-code')?.querySelector('pre code')?.textContent ?? ''); return }
    const link = event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : null
    if (!link?.startsWith('engram-artifact:')) return
    event.preventDefault()
    event.stopPropagation()
    setError('')
    try {
      void window.engram.artifactReveal(decodeURIComponent(link.slice('engram-artifact:'.length)))
        .catch(() => setError('This output file is unavailable. Ask the comet to check it.'))
    } catch { setError('This output link is invalid.') }
  }} dangerouslySetInnerHTML={{ __html: answerHtml(text) }} />{sites.length > 0 && <div className="answer-sites" aria-label="Websites in this answer">{sites.map(site => <span className="answer-site" key={site.origin} title={site.url}><SiteIcon origin={site.origin} /><span>{site.label}</span></span>)}</div>}{!compact && <div className="answer-actions"><button onClick={() => copy(text)} aria-label="Copy answer" title="Copy answer">{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}</button>{copied && <span role="status">Copied</span>}</div>}{error && <p role="alert">{error}</p>}</>
})
