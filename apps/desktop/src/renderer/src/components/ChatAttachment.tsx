import { Check, Copy, FileText, LoaderCircle, Paperclip, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChatAttachmentPreviewDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { uiLanguage } from '../i18n.js'
import { threadWords } from '../lib/threadLang.js'

export function ChatAttachment({ id, onRemove, disabled = false, lang = uiLanguage() }: { id: string; onRemove?(): void; disabled?: boolean; lang?: 'ko' | 'en' }) {
  const words = threadWords(lang).attachment
  const [preview, setPreview] = useState<ChatAttachmentPreviewDto | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<'' | 'unavailable' | 'video'>('')
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
    }).catch(() => { if (active) setError('unavailable') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [id])
  const text = preview?.text
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])
  return <div className={`chat-file-card${url ? ' media' : ''}`} data-testid="chat-file-card">
    {(onRemove || text !== undefined) && <div className="chat-file-actions">
      {text !== undefined && <button type="button" className="chat-file-action" data-testid="chat-file-copy" aria-label={words.copy(name)} title={copied ? words.copied : words.copy(name)} disabled={disabled} onClick={() => {
        setCopied(false)
        setCopyFailed(false)
        void window.engram.chatAttachmentCopy(id).then(() => setCopied(true), () => setCopyFailed(true))
      }}>{copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}</button>}
      {onRemove && <button type="button" className="chat-file-action" aria-label={words.remove(name)} disabled={disabled} onClick={onRemove}><X size={13} aria-hidden /></button>}
    </div>}
    {copied && <span className="sr-only" role="status">{words.copied}</span>}
    {copyFailed && <small role="alert">{words.copyFailed}</small>}
    {url && preview?.mime?.startsWith('image/') && <img src={url} alt={name} loading="lazy" />}
    {url && preview?.mime?.startsWith('video/') && <video src={url} controls preload="metadata" aria-label={name} onError={() => setError('video')} />}
    {text !== undefined ? <details><summary><FileText size={19} aria-hidden /><span><strong>{name === 'Pasted text.txt' ? text.trim().split('\n')[0]?.slice(0, 70) || name : name}</strong><small>{name} · {words.read}</small></span></summary><pre>{text}</pre>{preview?.truncated && <small>{words.limited}</small>}</details> : <div className="chat-file-label">{!preview && !error ? <LoaderCircle size={18} className="spin" aria-label={words.loadingLabel} /> : !url && <Paperclip size={18} aria-hidden />}<span><strong>{name}</strong><small>{error ? words[error] : preview ? `${Math.max(1, Math.round(preview.size / 1024))} KB` : words.loading}</small></span></div>}
  </div>
}

export function UserMessage({ text, attachments = [], lang = uiLanguage() }: { text: string; attachments?: string[]; lang?: 'ko' | 'en' }) {
  const names = attachments.map(id => id.slice(37)).join(', ')
  const suffix = `Attached: ${names}`
  const visible = attachments.length && text.endsWith(suffix) ? text.slice(0, -suffix.length).trimEnd() : text
  return <>{visible && <span className="chat-user-text">{visible}</span>}{attachments.length > 0 && <div className="chat-file-list" aria-label={threadWords(lang).attachment.list}>{attachments.map(id => <ChatAttachment key={id} id={id} lang={lang} />)}</div>}</>
}
