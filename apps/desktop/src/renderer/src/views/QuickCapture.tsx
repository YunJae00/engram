import { Lock, LockOpen } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'

export function QuickCapture() {
  const [text, setText] = useState('')
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const finish = () => {
    setText('')
    setError(false)
    api.hideQuickCapture()
  }

  // The window closing IS the success signal, so it must not close until the
  // write settled. On failure the text stays in the box and one line explains.
  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed) {
      finish()
      return
    }
    try {
      if (locked) await api.capturePrivate(trimmed)
      else await api.capture(trimmed)
      finish()
    } catch {
      setError(true)
    }
  }

  return (
    <div
      className="quick-capture"
      data-testid="quick-capture"
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'none' }}
      onDrop={(event) => event.preventDefault()}
    >
      <div className="quick-header">
        <span className="quick-title">{t('quick.title')}</span>
        <button
          className={`lock-toggle${locked ? ' locked' : ''}`}
          data-testid="lock-toggle"
          title={locked ? t('capture.lockPrivate') : t('capture.lockWorkspace')}
          onClick={() => {
            setLocked((v) => !v)
            inputRef.current?.focus()
          }}
        >
          {locked ? <Lock size={12} strokeWidth={1.8} aria-hidden /> : <LockOpen size={12} strokeWidth={1.8} aria-hidden />}{' '}
          {locked ? t('quick.lockedPrivate') : t('quick.lockedWorkspace')}
        </button>
      </div>
      <textarea
        ref={inputRef}
        autoFocus
        data-testid="quick-input"
        placeholder={t('quick.placeholder')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape') finish()
        }}
      />
      {error ? <div className="quick-hint quick-error" role="alert">{t('quick.saveFailed')}</div> : <div className="quick-hint">{t('quick.hint')}</div>}
    </div>
  )
}
