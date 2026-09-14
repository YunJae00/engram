import { memo, useState } from 'react'
import { answerHtml, memorySources } from '../markdown.js'
import { Copy, Check } from 'lucide-react'
import { answerSites, SiteIcon } from './SiteIcon.js'

// One answer, drawn from its own words. While a reply streams, the thread
// re-renders on every few characters; without this every older message in
// it would have its markdown parsed again each time, which is work that
// grows with the length of the conversation. Memoised on the text, an
// answer is parsed once and then left alone.

export const Answer = memo(function Answer({ text, compact = false, citations = false, streaming = false }: { text: string; compact?: boolean; citations?: boolean; streaming?: boolean }) {
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const sites = compact ? [] : answerSites(text)
  const notes = citations ? memorySources(text) : []
  const copy = (value: string) => {
    void window.engram.copyText(value).then(() => { setCopied(true); setError('') }).catch(() => setError('Could not copy. Select the text and copy it manually.'))
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
  }} dangerouslySetInnerHTML={{ __html: answerHtml(text, sites.map(site => site.url), notes.map(note => note.url)) }} />{!streaming && notes.length > 0 && <details className="answer-memory-sources"><summary>{notes.length} memory {notes.length === 1 ? 'source' : 'sources'}</summary><ol>{notes.map(note => <li key={note.url}><a href={note.url}>{note.label}</a></li>)}</ol></details>}{!streaming && sites.length > 0 && <div className="answer-sites" aria-label="Websites in this answer">{sites.map(site => <a className="answer-site" key={site.origin} href={site.url} title={site.url}><SiteIcon origin={site.origin} /><span>{site.label}</span></a>)}</div>}{!compact && !streaming && <div className="answer-actions"><button onClick={() => copy(text)} aria-label="Copy answer" title="Copy answer">{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}</button>{copied && <span role="status">Copied</span>}</div>}{error && <p role="alert">{error}</p>}</>
})
