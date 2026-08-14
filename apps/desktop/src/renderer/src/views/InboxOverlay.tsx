import { useEffect } from 'react'
import { useApp } from '../state.js'
import { api } from '../api.js'

// The scrap pile, unfolded: unfiled captures + failed items with a retry.
// A failed capture never disappears.
export function InboxOverlay() {
  const { inboxOpen, closeInbox, inbox, refresh, engines, t } = useApp()

  useEffect(() => {
    if (!inboxOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeInbox()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [inboxOpen, closeInbox])

  if (!inboxOpen) return null

  return (
    <div className="sheet-overlay" onClick={closeInbox}>
      <div className="brief-box" onClick={(e) => e.stopPropagation()} data-testid="inbox-overlay">
        <div className="brief-title">{t('inbox.title')}</div>
        <ul className="side-list" data-testid="inbox-list">
          {inbox.files.map((file) => (
            <li key={file.name} className="side-item static">
              <span className="side-title">{file.name}</span>
              <span className="side-sub">{file.preview}</span>
            </li>
          ))}
          {inbox.files.length === 0 && inbox.failures.length === 0 && (
            <li className="empty-hint">{t('inbox.empty')}</li>
          )}
        </ul>
        {inbox.failures.length > 0 && (
          <div className="failures">
            <div className="section-label">{t('inbox.failedItems')}</div>
            {inbox.failures.map((failure, i) => (
              <div key={i} className="failure-item">
                {failure.kind} — {failure.error}
              </div>
            ))}
            <button className="secondary" onClick={() => void api.inboxRetry().then(() => refresh())}>
              {t('inbox.retry')}
            </button>
          </div>
        )}
        {engines.length === 0 && <div className="engine-banner">{t('inbox.connectEngine')}</div>}
        <div className="dialog-actions">
          <button className="primary" onClick={closeInbox}>
            {t('inbox.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
