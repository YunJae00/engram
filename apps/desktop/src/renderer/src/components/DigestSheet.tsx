import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { renderMarkdown } from '../lib/markdown.js'
import { useEscape } from '../lib/useEscape.js'
import { t } from '../i18n.js'

export function DigestSheet({ onClose }: { onClose: () => void }) {
  const [digest, setDigest] = useState<string | null>(null)
  // Distinguishes "still reading the vault" from "no digest written yet", so
  // the empty line never flashes before the file has been looked for.
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void api.latestDigest().then((body) => {
      setDigest(body)
      setLoaded(true)
    })
  }, [])

  useEscape(onClose)

  return (
    <div className="sheet-overlay digest-overlay" onClick={onClose}>
      <div className="digest-sheet" data-testid="digest-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <span className="digest-title">{t('digest.title')}</span>
          <button className="sheet-close" aria-label={t('today.close')} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="digest-body">
          {digest ? (
            <article className="brief" data-testid="weekly-digest">
              {renderMarkdown(digest)}
            </article>
          ) : (
            loaded && <p className="digest-empty">{t('digest.empty')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
