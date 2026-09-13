import { ArrowUp, Paperclip, Square, X } from 'lucide-react'
import { forwardRef, memo, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ChatAttachmentDto } from '../../../shared/types.js'
import { attachmentError, ATTACHMENT_ACCEPT, ATTACHMENT_MAX_COUNT } from '../../../shared/attachments.js'
import { t } from '../i18n.js'
import { useAutoGrow } from '../lib/useAutoGrow.js'

interface Props {
  value: string
  placeholder: string
  maxLength: number
  busy: boolean
  disabled?: boolean
  testId?: string
  autoFocus?: boolean
  tools?: ReactNode
  attachments?: ChatAttachmentDto[]
  onAttachmentsChange?(next: ChatAttachmentDto[]): void
  onAttachingChange?(attaching: boolean): void
  onChange(value: string): void
  onSend(): void
  onStop(): void
}

export const ChatComposer = memo(
  forwardRef<HTMLTextAreaElement, Props>(function ChatComposer(
    { value, placeholder, maxLength, busy, disabled = false, testId, autoFocus = false, tools, attachments = [], onAttachmentsChange, onAttachingChange, onChange, onSend, onStop },
    ref,
  ) {
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const fileRef = useRef<HTMLInputElement>(null)
    const attachingRef = useRef(false)
    const [attaching, setAttaching] = useState(false)
    const [error, setError] = useState('')
    useImperativeHandle(ref, () => inputRef.current!)
    useAutoGrow(inputRef, value)

    const attach = async (files: File[]) => {
      if (!onAttachmentsChange || busy || disabled || attachingRef.current || !files.length) return
      if (attachments.length + files.length > ATTACHMENT_MAX_COUNT) { setError(`Attach up to ${ATTACHMENT_MAX_COUNT} files per message.`); return }
      const invalid = files.map(file => attachmentError(file.name, file.size)).find(Boolean)
      if (invalid) { setError(invalid); return }
      attachingRef.current = true
      setAttaching(true)
      onAttachingChange?.(true)
      setError('')
      const added: ChatAttachmentDto[] = []
      try {
        for (const file of files) added.push(await window.engram.chatAttach(file.name, new Uint8Array(await file.arrayBuffer())))
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      finally {
        if (added.length) onAttachmentsChange([...attachments, ...added])
        attachingRef.current = false
        setAttaching(false)
        onAttachingChange?.(false)
      }
    }
    const send = () => {
      if (busy || disabled || attachingRef.current || (!value.trim() && !attachments.length)) return
      onSend()
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
      event.preventDefault()
      send()
    }

    return (
      <div className="chat-write" onDragOver={event => {
        if (onAttachmentsChange && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation() }
      }} onDrop={event => {
        if (!onAttachmentsChange || !event.dataTransfer.files.length) return
        event.preventDefault()
        event.stopPropagation()
        void attach(Array.from(event.dataTransfer.files))
      }}>
        {attachments.length > 0 && <div className="chat-attachments" aria-label="Attached files">{attachments.map(one => <span className="chat-attachment" key={one.id} title={one.name}>
          <Paperclip size={12} aria-hidden /><span>{one.name}</span><button type="button" aria-label={`Remove ${one.name}`} disabled={attaching || busy || disabled} onClick={() => onAttachmentsChange?.(attachments.filter(file => file.id !== one.id))}><X size={12} aria-hidden /></button>
        </span>)}</div>}
        <textarea
          ref={inputRef}
          data-testid={testId}
          autoFocus={autoFocus}
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files)
            if (!onAttachmentsChange || !files.length) return
            event.preventDefault()
            event.stopPropagation()
            void attach(files)
          }}
        />
        {error && <p className="chat-attachment-error" role="alert">{error}</p>}
        {attaching && <span className="chat-attachment-status" role="status">Attaching files…</span>}
        <div className="chat-write-footer">
          <div className="chat-write-tools">{onAttachmentsChange && <>
            <input ref={fileRef} type="file" hidden multiple accept={ATTACHMENT_ACCEPT} data-testid={testId ? `${testId}-files` : undefined} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void attach(files) }} />
            <button type="button" className="chat-attach-button" aria-label="Attach files" title="Attach files · up to 8 files, 20 MB each" disabled={attaching || busy || disabled} onClick={() => fileRef.current?.click()}><Paperclip size={15} aria-hidden /></button>
          </>}{tools}</div>
          {busy ? (
            <button className="chat-send-btn armed bubble-stop" aria-label={t('bubble.stop')} onClick={onStop}>
              <Square size={11} strokeWidth={2.5} aria-hidden />
            </button>
          ) : (
            <button
              className="chat-send-btn armed"
              data-testid={testId ? `${testId}-send` : undefined}
              aria-label={t('chat.send')}
              disabled={disabled || attaching || (!value.trim() && !attachments.length)}
              onClick={send}
            >
              <ArrowUp size={16} strokeWidth={2.2} aria-hidden />
            </button>
          )}
        </div>
      </div>
    )
  }),
)
