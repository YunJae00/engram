import { Lock, LockOpen } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { blobBytes, imageFromPaste, PASTE_IMAGE_MAX_BYTES } from '../lib/paste.js'

export function QuickCapture() {
  const [text, setText] = useState('')
  const [locked, setLocked] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const finish = () => {
    setText('')
    api.hideQuickCapture()
  }

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) {
      finish()
      return
    }
    if (locked) void api.capturePrivate(trimmed)
    else void api.capture(trimmed)
    finish()
  }

  // Screenshot paste behaves like a file drop: capture and dismiss.
  const onPaste = (e: React.ClipboardEvent) => {
    const blob = imageFromPaste(e)
    if (!blob) return
    e.preventDefault()
    if (blob.size > PASTE_IMAGE_MAX_BYTES) return // silently refuse; window stays open
    void (async () => {
      await api.captureImage(await blobBytes(blob), locked)
      finish()
    })()
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    for (const file of Array.from(e.dataTransfer.files)) {
      const path = api.pathForFile(file)
      if (path) void api.captureFile(path)
    }
    const dropped = e.dataTransfer.getData('text/plain')
    if (dropped) void (locked ? api.capturePrivate(dropped) : api.capture(dropped))
    if (e.dataTransfer.files.length > 0 || dropped) finish()
  }

  return (
    <div
      className={`quick-capture${dragging ? ' dragging' : ''}`}
      data-testid="quick-capture"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
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
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape') finish()
        }}
      />
      <div className="quick-hint">{t('quick.hint')}</div>
    </div>
  )
}
