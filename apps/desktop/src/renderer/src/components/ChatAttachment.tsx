import { Check, Copy, FileText, LoaderCircle, Paperclip, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChatAttachmentPreviewDto } from '../../../shared/types.js'
import { api } from '../api.js'

export function ChatAttachment({ id, onRemove, disabled = false }: { id: string; onRemove?(): void; disabled?: boolean }) {
  const [preview, setPreview] = useState<ChatAttachmentPreviewDto | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const name = preview?.name ?? id.slice(37)
  useEffect(() => {
    let active = true
    let objectUrl = ''
    void api.chatAttachmentPreview(id).then(value => {
      if (!active) return
      setPreview(value)
      if (value.data && value.mime) {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(value.data)], { type: value.mime }))
        setUrl(objectUrl)
      }
    }).catch(() => { if (active) setError('Preview unavailable') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [id])
  const text = preview?.text
  // "Copied" is a transient acknowledgement, not state worth keeping: a pasted
  // block sits in the transcript indefinitely, so the tick has to clear itself
  // or a second copy of the same card would give no feedback at all.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  return <div className={`chat-file-card${url ? ' media' : ''}`} data-testid="chat-file-card">
    {(onRemove || text !== undefined) && <div className="chat-file-actions">
      {text !== undefined && <button type="button" className="chat-file-action" data-testid="chat-file-copy" aria-label={`Copy ${name}`} title={copyFailed ? 'Could not copy — select the text and copy it manually.' : copied ? 'Copied' : `Copy ${name}`} disabled={disabled} onClick={() => {
        void window.engram.copyText(text).then(() => { setCopied(true); setCopyFailed(false) }, () => { setCopyFailed(true); setCopied(false) })
      }}>{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}</button>}
      {onRemove && <button type="button" className="chat-file-action" aria-label={`Remove ${name}`} disabled={disabled} onClick={onRemove}><X size={13} aria-hidden /></button>}
    </div>}
    {copied && <span className="sr-only" role="status">Copied</span>}
    {url && preview?.mime?.startsWith('image/') && <img src={url} alt={name} loading="lazy" />}
    {url && preview?.mime?.startsWith('video/') && <video src={url} controls preload="metadata" aria-label={name} onError={() => setError('This video format cannot be played here.')} />}
    {text !== undefined ? <details><summary><FileText size={19} aria-hidden /><span><strong>{name === 'Pasted text.txt' ? text.trim().split('\n')[0]?.slice(0, 70) || name : name}</strong><small>{name} · Click to read</small></span></summary><pre>{text}</pre>{preview?.truncated && <small>Preview limited to 60,000 characters. The saved file is unchanged.</small>}</details> : <div className="chat-file-label">{!preview && !error ? <LoaderCircle size={18} className="spin" aria-label="Loading attachment" /> : !url && <Paperclip size={18} aria-hidden />}<span><strong>{name}</strong><small>{error || (preview ? `${Math.max(1, Math.round(preview.size / 1024))} KB` : 'Loading preview…')}</small></span></div>}
  </div>
}

export function UserMessage({ text, attachments = [] }: { text: string; attachments?: string[] }) {
  const names = attachments.map(id => id.slice(37)).join(', ')
  const suffix = `Attached: ${names}`
  const visible = attachments.length && text.endsWith(suffix) ? text.slice(0, -suffix.length).trimEnd() : text
  return <>{visible && <span className="chat-user-text">{visible}</span>}{attachments.length > 0 && <div className="chat-file-list" aria-label="Message attachments">{attachments.map(id => <ChatAttachment key={id} id={id} />)}</div>}</>
}
