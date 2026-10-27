import { useState } from 'react'
import { AlertCircle, Check, CloudOff, Copy, RotateCcw } from 'lucide-react'
import { threadT } from '../lib/threadLang.js'

export function isProviderError(text: string): boolean {
  if (!/^\[(codex|claude)\]\s*\{/i.test(text)) return false
  try { return (JSON.parse(text.slice(text.indexOf('{'))) as { type?: unknown }).type === 'error' } catch { return false }
}

// The provider took the request and failed on its side; read from the words
// when the failure arrived without its kind.
const OUTAGE_WORDS = /stream (?:disconnected|closed) before|before response\.completed|\b50[0234]\b|bad gateway|service unavailable|temporarily unavailable|overloaded|internal server error|server_error/i

const providerOf = (text: string, provider?: string): string =>
  provider || (/^\[codex\]/i.test(text) ? 'ChatGPT' : /^\[claude\]/i.test(text) ? 'Claude' : '')

export function ErrorAnswer({ text, kind, provider, lang = 'en', onRetry }: { text: string; kind?: string; provider?: string; lang?: 'en' | 'ko'; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  if (kind === 'outage' || (!kind && OUTAGE_WORDS.test(text))) {
    const t = threadT(lang), name = providerOf(text, provider) || 'AI'
    return <div className="answer-error outage" role="status" data-testid="answer-outage">
      <div className="answer-error-heading"><CloudOff size={18} aria-hidden /><strong>{t('outage.title', { name })}</strong></div>
      <p>{t('outage.body', { name })}</p>
      {onRetry && <button className="answer-error-copy" data-testid="answer-outage-retry" onClick={onRetry}><RotateCcw size={14} aria-hidden />{t('outage.again')}</button>}
      <details><summary>{t('outage.details')}</summary><pre>{text}</pre></details>
    </div>
  }
  const schemaError = /invalid_json_schema|Invalid schema for response_format/i.test(text)
  let brief = text
  try {
    const envelope = JSON.parse(text.slice(text.indexOf('{'))) as { error?: { message?: unknown }; message?: unknown }
    const message = envelope.error?.message ?? envelope.message
    if (typeof message === 'string') brief = message
  } catch { /* Plain-text errors already carry their explanation. */ }
  brief = brief.replace(/^\[(codex|claude)\]\s*/i, '').trim()
  return <div className="answer-error" role="alert">
    <div className="answer-error-heading"><AlertCircle size={18} aria-hidden /><strong>Could not complete this request</strong></div>
    <p>{schemaError ? 'The AI rejected the request format. This is an app error, not a usage limit.' : brief.length > 260 ? `${brief.slice(0, 257)}…` : brief || 'The request stopped. Check the error details before trying again.'}</p>
    <details><summary>Error details</summary><pre>{text}</pre></details>
    <button className="answer-error-copy" onClick={() => {
      void window.engram.copyText(text).then(() => { setCopied(true); setCopyError(false) }).catch(() => setCopyError(true))
    }}>{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? 'Copied' : 'Copy error'}</button>
    {copyError && <p>Could not copy. Select the error text and copy it manually.</p>}
  </div>
}
