import { memo, useState } from 'react'
import { answerFiles, answerHtml, answerText, memorySources } from '../markdown.js'
import { AnswerFiles } from './AnswerFiles.js'
import { Copy, Check } from 'lucide-react'
import { answerSites, SiteIcon } from './SiteIcon.js'
import { t } from '../i18n.js'

export const Answer = memo(function Answer({ text: rawText, compact = false, citations = false, streaming = false, skipFiles = '', staleLinks = '' }: { text: string; compact?: boolean; citations?: boolean; streaming?: boolean; skipFiles?: string; staleLinks?: string }) {
  const text = answerText(rawText)
  const { text: body, files: linked } = answerFiles(text, staleLinks)
  const files = skipFiles ? linked.filter(file => !skipFiles.split('\n').includes(file.id)) : linked
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const sites = compact ? [] : answerSites(text)
  const notes = citations ? memorySources(text) : []
  const copy = (value: string) => {
    void window.engram.copyText(value).then(() => { setCopied(true); setError('') }).catch(() => setError(t('answer.copyFailed')))
  }
  return <><div className="bubble-msg-body" onClick={(event) => {
    const codeButton = event.target instanceof Element ? event.target.closest('[data-copy-code]') : null
    if (codeButton) { copy(codeButton.closest('.answer-code')?.querySelector('pre code')?.textContent ?? ''); return }
    const link = event.target instanceof Element ? event.target.closest('a')?.getAttribute('href') : null
    if (!link?.startsWith('engram-artifact:')) return
    event.preventDefault()
    event.stopPropagation()
    setError('')
    try { window.dispatchEvent(new CustomEvent('engram:open-artifact', { detail: decodeURIComponent(link.slice('engram-artifact:'.length)) })) }
    catch { setError(t('answer.badLink')) }
  }} dangerouslySetInnerHTML={{ __html: answerHtml(body, sites.map(site => site.url), notes.map(note => note.url)) }} />{!streaming && files.length > 0 && <AnswerFiles files={files} />}{!streaming && notes.length > 0 && <details className="answer-memory-sources"><summary>{t(notes.length === 1 ? 'answer.memorySourcesOne' : 'answer.memorySources', { n: notes.length })}</summary><ol>{notes.map(note => <li key={note.url}><a href={note.url}>{note.label}</a></li>)}</ol></details>}{!streaming && sites.length > 0 && <div className="answer-sites" aria-label={t('answer.sites')}>{sites.map(site => <a className="answer-site" key={site.origin} href={site.url} title={site.url}><SiteIcon origin={site.origin} /><span>{site.label}</span></a>)}</div>}{!compact && !streaming && <div className="answer-actions"><button onClick={() => copy(text)} aria-label={t('answer.copy')} title={t('answer.copy')}>{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}</button>{copied && <span role="status">{t('error.copied')}</span>}</div>}{error && <p role="alert">{error}</p>}</>
})
