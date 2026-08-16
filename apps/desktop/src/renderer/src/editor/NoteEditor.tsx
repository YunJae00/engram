import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { marked } from 'marked'
import { useEffect, useRef, useState } from 'react'
import type { NoteDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useApp } from '../state.js'
import { LineageStrip } from './LineageStrip.js'
import { LinksPanel } from './LinksPanel.js'
import { MetaBar } from './MetaBar.js'

export function NoteEditor({ noteId, onDiff }: { noteId: string; onDiff(fromId: string): void }) {
  const { theme, t } = useApp()
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  // The debounced save used to be CANCELLED on unmount, so the last keystrokes
  // before closing the sheet were dropped. Keep the newest text and the note it
  // belongs to, and flush on the way out.
  const unsaved = useRef<{ id: string; text: string } | null>(null)
  const previewTimer = useRef<number | undefined>(undefined)
  const [note, setNote] = useState<NoteDto | null>(null)
  const [previewHtml, setPreviewHtml] = useState('')
  const [showPreview, setShowPreview] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api.readNote(noteId).then(({ note: dto, body }) => {
      if (cancelled || !host.current) return
      setNote(dto)
      setPreviewHtml(marked.parse(body, { async: false }))
      viewRef.current?.destroy()
      viewRef.current = new EditorView({
        doc: body,
        parent: host.current,
        extensions: [
          markdown(),
          history(),
          lineNumbers(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          ...(theme === 'dark' ? [oneDark] : []),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const text = update.state.doc.toString()
            // The save was debounced but the PREVIEW was not: every keystroke
            // re-parsed the whole document with marked and re-rendered the
            // preview subtree through dangerouslySetInnerHTML. On a long note
            // that is the typing lag. The preview is a glance, not a
            // character-accurate mirror — a beat behind is invisible.
            window.clearTimeout(previewTimer.current)
            previewTimer.current = window.setTimeout(() => setPreviewHtml(marked.parse(text, { async: false })), 120)
            unsaved.current = { id: noteId, text }
            setSaving(true)
            window.clearTimeout(saveTimer.current)
            saveTimer.current = window.setTimeout(() => {
              unsaved.current = null
              void api.saveNoteBody(noteId, text).finally(() => setSaving(false))
            }, 600)
          }),
        ],
      })
    })
    return () => {
      cancelled = true
      window.clearTimeout(saveTimer.current)
      window.clearTimeout(previewTimer.current)
      const pending = unsaved.current
      unsaved.current = null
      if (pending) void api.saveNoteBody(pending.id, pending.text)
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [noteId, theme])

  return (
    <div className="note-editor" data-testid="note-editor">
      <div className="editor-save" data-testid="editor-save">{saving ? t('editor.saving') : t('editor.saved')}</div>
      {note && <MetaBar note={note} onChange={setNote} />}
      {note && <LineageStrip noteId={noteId} onDiff={onDiff} />}
      {note && <LinksPanel noteId={noteId} />}
      <div className="editor-split">
        <div ref={host} className="cm-host" data-testid="cm-host" />
        {showPreview && (
          <div className="preview" data-testid="preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        )}
      </div>
      <button className="preview-toggle" onClick={() => setShowPreview((v) => !v)}>
        {showPreview ? t('sheet.hidePreview') : t('sheet.showPreview')}
      </button>
    </div>
  )
}
