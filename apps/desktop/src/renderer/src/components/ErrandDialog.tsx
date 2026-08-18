import { useState } from 'react'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'

// Delegate a goal to the on-device librarian. The submit only STARTS the run
// (core's runErrand is detached in main) — progress and the outcome surface as
// errand:phase events on the top bar and a toast, so this closes immediately.
export function ErrandDialog({ onClose }: { onClose(): void }) {
  const { startErrand, t } = useApp()
  const [value, setValue] = useState('')

  useEscape(onClose, true)

  const submit = () => {
    if (!value.trim()) return
    void startErrand(value)
    onClose()
  }

  return (
    <div className="brief-overlay" onClick={onClose}>
      <div className="brief-box" onClick={(e) => e.stopPropagation()}>
        <div className="brief-title">{t('errand.title')}</div>
        <textarea
          autoFocus
          className="errand-input"
          placeholder={t('errand.placeholder')}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          // Enter delegates; Shift+Enter is a newline, as the box is multi-line.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="dialog-actions">
          <button className="primary" onClick={submit}>
            {t('errand.start')}
          </button>
          <button className="secondary" onClick={onClose}>
            {t('palette.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
