import { Check, Copy, FileText, LoaderCircle, Paperclip, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChatAttachmentPreviewDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { uiLanguage } from '../i18n.js'

// The card speaks the conversation's language in a thread and the app's in the composer; file names stay as they are.
const WORDS = {
  en: { copy: (name: string) => `Copy ${name}`, copied: 'Copied', remove: (name: string) => `Remove ${name}`, copyFailed: 'Could not copy the full attachment. Try again; the saved file is unchanged.', read: 'Click to read', limited: 'Preview limited to 60,000 characters. The saved file is unchanged.', loading: 'Loading preview…', loadingLabel: 'Loading attachment', unavailable: 'Preview unavailable', video: 'This video format cannot be played here.', attachments: 'Message attachments' },
  ko: { copy: (name: string) => `${name} 복사`, copied: '복사했어요', remove: (name: string) => `${name} 빼기`, copyFailed: '전체를 복사하지 못했어요. 다시 눌러 주세요. 저장된 파일은 그대로예요.', read: '눌러서 읽기', limited: '앞부분 6만 자만 보여 드려요. 저장된 파일은 그대로예요.', loading: '불러오는 중…', loadingLabel: '첨부 파일 불러오는 중', unavailable: '미리 볼 수 없어요', video: '이 영상 형식은 여기서 재생할 수 없어요.', attachments: '첨부한 파일' },
} as const
export const attachmentWords = (lang: 'ko' | 'en') => WORDS[lang]

export function ChatAttachment({ id, onRemove, disabled = false, lang = uiLanguage() }: { id: string; onRemove?(): void; disabled?: boolean; lang?: 'ko' | 'en' }) {
  const words = WORDS[lang]
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
  // Clear feedback so subsequent copies can be acknowledged again.
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
  return <>{visible && <span className="chat-user-text">{visible}</span>}{attachments.length > 0 && <div className="chat-file-list" aria-label={WORDS[lang].attachments}>{attachments.map(id => <ChatAttachment key={id} id={id} lang={lang} />)}</div>}</>
}
