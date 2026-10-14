import { ArrowUp, ExternalLink, LoaderCircle, Paperclip, Plus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, apiErrorText } from '../api.js'
import type { AppSettingsDto, ChatAttachmentDto } from '../../../shared/types.js'
import { attachmentError, ATTACHMENT_MAX_COUNT } from '../../../shared/attachments.js'

export function QuickCapture() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [menu, setMenu] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [files, setFiles] = useState<ChatAttachmentDto[]>([])
  const barRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const attachingRef = useRef(false)
  const sending = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    document.body.classList.add('quick-host')
    return () => document.body.classList.remove('quick-host')
  }, [])
  useEffect(() => {
    const focus = () => {
      setMenu(false)
      if (barRef.current) void api.quickLayout(Math.ceil(barRef.current.scrollHeight) + 20).catch(() => undefined)
      inputRef.current?.focus()
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) inputRef.current?.parentElement?.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 140, easing: 'ease-out' })
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [])
  useEffect(() => { if (menu) menuRef.current?.querySelector('button')?.focus() }, [menu])
  useEffect(() => {
    const host = barRef.current
    if (!host) return
    const observer = new ResizeObserver(() => void api.quickLayout(Math.ceil(host.scrollHeight) + 20).catch(() => undefined))
    observer.observe(host)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    let theme: AppSettingsDto['theme'] = 'system', alive = true, updated = false
    const apply = () => { document.documentElement.dataset['theme'] = theme === 'light' || theme === 'dark' ? theme : media.matches ? 'dark' : 'light' }
    const off = api.onEvent(event => { if (event.type === 'settings:changed') { updated = true; theme = event.settings.theme; apply() } })
    void api.settingsGet().then(settings => { if (alive && !updated) { theme = settings.theme; apply() } }).catch(() => undefined)
    media.addEventListener('change', apply)
    return () => { alive = false; off(); media.removeEventListener('change', apply) }
  }, [])

  const submit = async () => {
    if (!text.trim() || sending.current || attachingRef.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      await api.quickComet(text, files.map(file => file.id))
      setText('')
      setFiles([])
      setMenu(false)
      api.hideQuickCapture()
    } catch (cause) {
      setError(apiErrorText(cause instanceof Error ? cause.message : String(cause)))
      inputRef.current?.focus()
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  const attach = async (dropped?: File[]) => {
    if (attachingRef.current || sending.current) return
    attachingRef.current = true; setAttaching(true); setMenu(false); setError('')
    const added: ChatAttachmentDto[] = []
    try {
      if (dropped) {
        if (files.length + dropped.length > ATTACHMENT_MAX_COUNT) throw new Error(`Attach up to ${ATTACHMENT_MAX_COUNT} files per message.`)
        const invalid = dropped.map(file => attachmentError(file.name, file.size)).find(Boolean)
        if (invalid) throw new Error(invalid)
        for (const file of dropped) added.push(await api.chatAttach(file.name, new Uint8Array(await file.arrayBuffer())))
      } else added.push(...await api.quickPickFiles(files.length))
    } catch (cause) { setError(apiErrorText(cause instanceof Error ? cause.message : String(cause))) }
    finally { setFiles(prior => [...prior, ...added]); attachingRef.current = false; setAttaching(false); inputRef.current?.focus() }
  }

  return <div className="quick-capture" data-testid="quick-capture" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); if (menu) { setMenu(false); addRef.current?.focus() } else api.hideQuickCapture() }
  }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => {
    if (event.dataTransfer.files.length) { event.preventDefault(); void attach(Array.from(event.dataTransfer.files)) }
  }}>
    <div ref={barRef} className="quick-content">
    {menu && <div ref={menuRef} id="quick-actions" className="quick-menu" role="group" aria-label="Quick chat actions">
      <button type="button" disabled={attaching || busy} onClick={() => void attach()}><Paperclip size={16} aria-hidden />Attach files</button>
      <button type="button" onClick={() => { setMenu(false); void api.quickOpenApp() }}><ExternalLink size={16} aria-hidden />Open Engram</button>
    </div>}
    <div className="quick-bar">
    {files.length > 0 && <div className="quick-files" aria-label="Attached files">{files.map(file => <button type="button" key={file.id} disabled={busy || attaching} aria-label={`Remove ${file.name}`} title={file.name} onClick={() => setFiles(prior => prior.filter(one => one.id !== file.id))}><span>{file.name}</span><X size={12} aria-hidden /></button>)}</div>}
    <div className="quick-row">
    <button type="button" ref={addRef} className="quick-add" aria-label="Quick chat actions" aria-controls="quick-actions" aria-expanded={menu} disabled={busy || attaching} onClick={() => setMenu(prior => !prior)} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setMenu(true) } }}>{attaching ? <LoaderCircle size={18} className="spin" aria-hidden /> : <Plus size={20} aria-hidden />}</button>
    <textarea ref={inputRef} autoFocus rows={Math.min(2, text.split('\n').length)} aria-label="Comet message" data-testid="quick-input" placeholder="Ask Engram…" maxLength={20_000} value={text} readOnly={busy}
      onChange={event => { setText(event.target.value); setError('') }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
      }}
      onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void attach(Array.from(event.clipboardData.files)) } }} />
    <button className="quick-send" aria-label="Start Comet" title="Start Comet (Enter)" disabled={busy || attaching || !text.trim()} onClick={() => void submit()}>{busy ? <LoaderCircle size={17} className="spin" aria-hidden /> : <ArrowUp size={17} aria-hidden />}</button>
    <button type="button" className="quick-close" aria-label="Close quick chat" title="Close (Esc)" onClick={() => api.hideQuickCapture()}><X size={14} aria-hidden /></button></div>
    {error && <span className="quick-error" role="alert">{error}</span>}
    </div></div>
  </div>
}
