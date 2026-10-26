import { AppWindow, ArrowUp, Paperclip, Plus, Square } from 'lucide-react'
import { ChatAttachment } from './ChatAttachment.js'
import { forwardRef, memo, useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ChatAttachmentDto } from '../../../shared/types.js'
import { attachmentError, ATTACHMENT_ACCEPT, ATTACHMENT_MAX_COUNT } from '../../../shared/attachments.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { useAutoGrow } from '../lib/useAutoGrow.js'

interface Props {
  value: string
  placeholder: string
  maxLength: number
  busy: boolean
  canQueue?: boolean
  disabled?: boolean
  testId?: string
  autoFocus?: boolean
  tools?: ReactNode
  actions?: ReactNode
  attachments?: ChatAttachmentDto[]
  onAttachmentsChange?(next: ChatAttachmentDto[]): void
  onAttachingChange?(attaching: boolean): void
  onChange(value: string): void
  onSend(): void
  onStop(): void
}

// "@" names an app the person lets Engram work in (Settings, Apps); the list
// is asked once and again after settings change.
const MENTION = /(?:^|\s)@([^\s@]{0,40})$/
// Every allowed app can be picked; the menu scrolls past a few rows.
const MENTIONS_SHOWN = 40
const MENTION_MENU_MAX = 320
interface Mentionable { label: string; icon?: string }
// The apps in use fill in as the activity journal grows, so the list is read
// again once it is a minute old, and an empty one is not kept.
const MENTIONS_FRESH_MS = 60_000
let mentionable: { at: number; apps: Promise<Mentionable[]> } | null = null
const allowedApps = (): Promise<Mentionable[]> => {
  if (mentionable && Date.now() - mentionable.at < MENTIONS_FRESH_MS) return mentionable.apps
  const apps = api.appsList().then(rows => rows.filter(one => one.on).map(one => ({ label: one.label, ...(one.icon ? { icon: one.icon } : {}) }))).catch(() => [])
  const held = { at: Date.now(), apps }
  mentionable = held
  void apps.then(list => { if (!list.length && mentionable === held) mentionable = null })
  return apps
}
// An app named in the box, shown with its icon so the person sees it was taken.
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const namedIn = (text: string, apps: Mentionable[]) => text.includes('@') ? apps.filter(app => new RegExp(`(?:^|\\s)@${escaped(app.label)}(?![A-Za-z0-9])`, 'i').test(text)) : []
const appMark = (app: Mentionable, size: number) => app.icon ? <img className="app-icon" src={app.icon} alt="" /> : <AppWindow size={size} aria-hidden />

export const ChatComposer = memo(
  forwardRef<HTMLTextAreaElement, Props>(function ChatComposer(
    { value, placeholder, maxLength, busy, canQueue = false, disabled = false, testId, autoFocus = false, tools, actions, attachments = [], onAttachmentsChange, onAttachingChange, onChange, onSend, onStop },
    ref,
  ) {
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const fileRef = useRef<HTMLInputElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const addRef = useRef<HTMLButtonElement>(null)
    const menuId = useId()
    const attachingRef = useRef(false)
    const [attaching, setAttaching] = useState(false)
    const [error, setError] = useState('')
    const mentionRef = useRef<HTMLDivElement>(null)
    const [mention, setMention] = useState<{ at: number; options: Mentionable[]; pick: number } | null>(null)
    const [apps, setApps] = useState<Mentionable[]>([])
    const hasAt = value.includes('@')
    useEffect(() => { if (hasAt) void allowedApps().then(setApps) }, [hasAt])
    const named = namedIn(value, apps)
    useImperativeHandle(ref, () => inputRef.current!)
    useAutoGrow(inputRef, value)

    const placeMenu = () => {
      const anchor = addRef.current?.getBoundingClientRect()
      if (anchor && menuRef.current) Object.assign(menuRef.current.style, { left: `${Math.max(8, Math.min(anchor.left, innerWidth - 228))}px`, bottom: `${innerHeight - anchor.top + 6}px`, maxHeight: `${Math.max(0, anchor.top - 14)}px` })
    }
    useEffect(() => {
      const place = () => { if (menuRef.current?.matches(':popover-open')) placeMenu() }
      const observer = new ResizeObserver(place)
      if (inputRef.current?.parentElement) observer.observe(inputRef.current.parentElement)
      const host = inputRef.current?.closest('.bots-main, .mini-chat, .cosmos-chat, .app-main')
      if (host) observer.observe(host)
      window.addEventListener('resize', place)
      window.addEventListener('scroll', place, true)
      return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
    }, [])
    useEffect(() => api.onEvent(event => { if (event.type === 'settings:changed') mentionable = null }), [])
    useEffect(() => {
      const menu = mentionRef.current
      const anchor = inputRef.current?.getBoundingClientRect()
      if (!menu) return
      if (!mention || !anchor) { if (menu.matches(':popover-open')) menu.hidePopover(); return }
      Object.assign(menu.style, { left: `${Math.max(8, Math.min(anchor.left, innerWidth - 228))}px`, bottom: `${innerHeight - anchor.top + 6}px`, maxHeight: `${Math.max(0, Math.min(MENTION_MENU_MAX, anchor.top - 14))}px` })
      if (!menu.matches(':popover-open')) menu.showPopover()
      menu.querySelector('.picked')?.scrollIntoView({ block: 'nearest' })
    }, [mention])

    const lookForMention = (text: string, caret: number) => {
      const hit = MENTION.exec(text.slice(0, caret))
      if (!hit) { setMention(null); return }
      const query = (hit[1] ?? '').toLowerCase()
      void allowedApps().then(apps => {
        const options = apps.filter(app => app.label.toLowerCase().includes(query)).slice(0, MENTIONS_SHOWN)
        setMention(options.length ? { at: caret - query.length - 1, options, pick: 0 } : null)
      })
    }
    const chooseMention = (app: string) => {
      const input = inputRef.current
      if (!mention || !input) return
      const before = `${value.slice(0, mention.at)}@${app} `
      onChange(before + value.slice(input.selectionStart))
      setMention(null)
      requestAnimationFrame(() => { input.focus(); input.setSelectionRange(before.length, before.length) })
    }

    const attach = async (files: File[]) => {
      if (!onAttachmentsChange || (busy && !canQueue) || disabled || attachingRef.current || !files.length) return
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
      if ((busy && !canQueue) || disabled || attachingRef.current || (!value.trim() && !attachments.length)) return
      onSend()
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mention && !event.nativeEvent.isComposing) {
        const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
        if (step) { event.preventDefault(); setMention({ ...mention, pick: (mention.pick + step + mention.options.length) % mention.options.length }); return }
        if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); chooseMention(mention.options[mention.pick]?.label ?? ''); return }
        if (event.key === 'Escape') { event.preventDefault(); setMention(null); return }
      }
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
        {attachments.length > 0 && <div className="chat-file-list" aria-label="Attached files">{attachments.map(one => <ChatAttachment key={one.id} id={one.id} disabled={attaching || (busy && !canQueue) || disabled} onRemove={() => onAttachmentsChange?.(attachments.filter(file => file.id !== one.id))} />)}</div>}
        {named.length > 0 && <div className="chat-mention-list" aria-label="Apps named" data-testid={testId ? `${testId}-named` : undefined}>{named.map(app => <span key={app.label} className="chat-mention-chip">{appMark(app, 14)}<span>{app.label}</span></span>)}</div>}
        {(onAttachmentsChange || actions) && <>
          <button type="button" ref={addRef} className="chat-add-button" aria-label="Add to conversation" data-testid={testId ? `${testId}-add` : undefined} {...{ popovertarget: menuId }} onClick={placeMenu}><Plus size={18} aria-hidden /></button>
          <div ref={menuRef} id={menuId} className="chat-add-menu" {...{ popover: 'auto' }} aria-label="Conversation actions" onClick={event => { if ((event.target as HTMLElement).closest('button:not(:disabled)')) menuRef.current?.hidePopover() }}>
            {onAttachmentsChange && <button type="button" className="chat-attach-button" aria-label="Attach files" title="Attach files · up to 8 files, 20 MB each" disabled={attaching || (busy && !canQueue) || disabled} onClick={() => fileRef.current?.click()}><Paperclip size={16} aria-hidden /><span>Attach files</span></button>}
            {actions}
          </div>
        </>}
        <textarea
          ref={inputRef}
          data-testid={testId}
          autoFocus={autoFocus}
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          onChange={(event) => { onChange(event.target.value); lookForMention(event.target.value, event.target.selectionStart) }}
          onKeyDown={onKeyDown}
          onBlur={() => setMention(null)}
          onPaste={event => {
            const files = Array.from(event.clipboardData.files)
            const text = event.clipboardData.getData('text/plain')
            if (!onAttachmentsChange || (!files.length && text.length < 2000 && text.split('\n').length < 20)) return
            event.preventDefault()
            event.stopPropagation()
            void attach(files.length ? files : [new File([text], 'Pasted text.txt', { type: 'text/plain' })])
          }}
        />
        <div ref={mentionRef} className="chat-add-menu chat-mention-menu" {...{ popover: 'manual' }} role="listbox" aria-label="Apps" data-testid={testId ? `${testId}-mentions` : undefined}>
          {mention?.options.map((app, index) => (
            <button key={app.label} type="button" role="option" aria-selected={index === mention.pick} className={index === mention.pick ? 'picked' : undefined} onMouseDown={event => { event.preventDefault(); chooseMention(app.label) }}>
              {appMark(app, 16)}<span>@{app.label}</span>
            </button>
          ))}
        </div>
        <div className="chat-write-footer">
          <div className="chat-write-tools">{onAttachmentsChange && <>
            <input ref={fileRef} type="file" hidden multiple accept={ATTACHMENT_ACCEPT} data-testid={testId ? `${testId}-files` : undefined} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void attach(files) }} />
          </>}{tools}</div>
          {/* One button: words in the box send, an empty box stops. */}
          {busy && !(canQueue && (value.trim() || attachments.length > 0)) ? (
            <button className="chat-send-btn armed bubble-stop" aria-label={t('bubble.stop')} onClick={onStop}>
              <Square size={11} strokeWidth={2.5} aria-hidden />
            </button>
          ) : (
            <button
              className="chat-send-btn armed"
              data-testid={testId ? `${testId}-send` : undefined}
              aria-label={busy ? 'Queue message' : t('chat.send')}
              title={busy ? 'Send after this reply' : undefined}
              disabled={disabled || attaching || (!value.trim() && !attachments.length)}
              onClick={send}
            >
              <ArrowUp size={16} strokeWidth={2.2} aria-hidden />
            </button>
          )}
        </div>
        {error && <p className="chat-attachment-error" role="alert">{error}</p>}
        {attaching && <span className="chat-attachment-status" role="status">Attaching files…</span>}
      </div>
    )
  }),
)
