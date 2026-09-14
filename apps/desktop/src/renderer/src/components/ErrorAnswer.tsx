import { useState } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'

export function isProviderError(text: string): boolean {
  if (!/^\[(codex|claude)\]\s*\{/i.test(text)) return false
  try { return (JSON.parse(text.slice(text.indexOf('{'))) as { type?: unknown }).type === 'error' } catch { return false }
}

export function ErrorAnswer({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
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
