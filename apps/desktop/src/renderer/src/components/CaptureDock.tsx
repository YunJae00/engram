import { Pin } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { useApp } from '../state.js'

// Capture, pinned to the cosmos's right edge. It used to be a floating pill
// that opened a chat panel — two hops and two surfaces for the app's most
// basic verb. Now the thought goes straight from this box into the inbox,
// and the starter chips' seeds land here too.
export function CaptureDock() {
  const { showToast, refresh, t } = useApp()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const focus = (event: Event) => {
      const seed = (event as CustomEvent<{ seed?: string }>).detail?.seed
      if (seed) setText(seed)
      setTimeout(() => boxRef.current?.focus(), 60)
    }
    window.addEventListener('engram:focus-capture', focus)
    return () => window.removeEventListener('engram:focus-capture', focus)
  }, [])

  const submit = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await api.capture(body)
      setText('')
      showToast(t('toast.promoted'))
      await refresh()
    } catch (err) {
      showToast(t('toast.actionFailed', { reason: String((err as Error).message ?? err).slice(0, 120) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="capture-dock" data-testid="capture-dock">
      <div className="capture-dock-title">
        <Pin size={13} strokeWidth={1.8} aria-hidden /> {t('capture.submit')}
      </div>
      <textarea
        ref={boxRef}
        data-testid="capture-input"
        rows={3}
        maxLength={4000}
        placeholder={t('capture.dockPlaceholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <button className="primary" data-testid="capture-submit" disabled={busy || !text.trim()} onClick={() => void submit()}>
        {t('capture.submit')}
      </button>
    </aside>
  )
}
