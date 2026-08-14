import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { DiffView } from '../editor/DiffView.js'
import { NoteEditor } from '../editor/NoteEditor.js'
import { useApp } from '../state.js'

// Note sheet: click a post-it → the note slides up as an overlay.
// Lineage clicks swap the body for a version diff, Back returns to editing.
export function NoteSheet() {
  const { sheetNoteId, closeNote, t } = useApp()
  const [diffFrom, setDiffFrom] = useState<string | null>(null)
  const [docs, setDocs] = useState<{ left: string; right: string } | null>(null)

  useEffect(() => {
    setDiffFrom(null)
    setDocs(null)
  }, [sheetNoteId])

  useEffect(() => {
    if (!sheetNoteId || !diffFrom) return
    void Promise.all([api.readNoteBody(diffFrom), api.readNoteBody(sheetNoteId)]).then(([left, right]) =>
      setDocs({ left, right }),
    )
  }, [diffFrom, sheetNoteId])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNote()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeNote])

  if (!sheetNoteId) return null

  return (
    <div className="sheet-overlay" onClick={closeNote}>
      <div className="note-sheet" data-testid="note-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          {diffFrom ? (
            <button className="secondary" onClick={() => setDiffFrom(null)}>
              {t('sheet.back')}
            </button>
          ) : (
            <span className="sheet-hint">{t('sheet.hint')}</span>
          )}
          <button className="sheet-close" aria-label={t('sheet.closeNote')} onClick={closeNote}>
            ✕
          </button>
        </div>
        {diffFrom && docs ? (
          <DiffView left={docs.left} right={docs.right} leftLabel={t('sheet.olderVersion')} rightLabel={t('sheet.current')} />
        ) : (
          <NoteEditor key={sheetNoteId} noteId={sheetNoteId} onDiff={setDiffFrom} />
        )}
      </div>
    </div>
  )
}
