import { ArrowUp, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, apiErrorText } from '../api.js'
import type { AppSettingsDto } from '../../../shared/types.js'
import { Comet } from '../components/Icon.js'

export function QuickCapture() {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sending = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus()
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) inputRef.current?.parentElement?.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 140, easing: 'ease-out' })
    }
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
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
    if (!text.trim() || sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    try {
      await api.quickComet(text)
      setText('')
      api.hideQuickCapture()
    } catch (cause) {
      setError(apiErrorText(cause instanceof Error ? cause.message : String(cause)))
      inputRef.current?.focus()
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return <div className="quick-capture" data-testid="quick-capture" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); api.hideQuickCapture() }
  }}>
    <div className="quick-row"><Comet size={20} />
    <textarea ref={inputRef} autoFocus rows={Math.min(2, text.split('\n').length)} aria-label="Comet message" data-testid="quick-input" placeholder="Ask Engram…" maxLength={20_000} value={text} readOnly={busy}
      onChange={event => { setText(event.target.value); setError('') }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() }
      }} />
    <button className="quick-send" aria-label="Start Comet" title="Start Comet (Enter)" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? <LoaderCircle size={17} className="spin" aria-hidden /> : <ArrowUp size={17} aria-hidden />}</button></div>
    {error && <span className="quick-error" role="alert">{error}</span>}
  </div>
}
