import { Check, Copy, FolderOpen, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArtifactViewDto } from '../../../shared/types.js'
import { renderMarkdown } from '../lib/markdown.js'

export function ArtifactSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [view, setView] = useState<ArtifactViewDto | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useLayoutEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  useEffect(() => {
    let alive = true
    setView(null); setError(''); setCopied(false)
    window.engram.artifactRead(id).then((next) => { if (alive) setView(next) }).catch(() => { if (alive) setError('This output file is unavailable. Ask the comet to check it.') })
    return () => { alive = false }
  }, [id])
  const reveal = () => void window.engram.artifactReveal(id).catch(() => setError('Could not open the folder.'))
  const copy = () => { if (view?.text) void window.engram.copyText(view.text).then(() => setCopied(true)).catch(() => setError('Could not copy. Select the text and copy it manually.')) }
  const markdown = /\.md$/i.test(view?.name ?? '')
  return createPortal(<dialog ref={dialog} className="artifact-sheet" aria-label={view?.name ?? 'Output file'} data-testid="artifact-sheet"
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const box = event.currentTarget.getBoundingClientRect()
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose()
    }}>
      <div className="artifact-sheet-head">
        <h2 title={view?.name}>{view?.name ?? 'Loading…'}</h2>
        {view?.text && <button className="secondary" onClick={copy} aria-label="Copy contents" title="Copy contents">{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}</button>}
        <button className="secondary" onClick={reveal} aria-label="Show in folder" title="Show in folder"><FolderOpen size={14} aria-hidden /></button>
        <button className="secondary" onClick={onClose} aria-label="Close" title="Close"><X size={14} aria-hidden /></button>
      </div>
      <div className="artifact-sheet-body" aria-busy={!view && !error}>
        {error && <p className="computer-error" role="alert">{error}</p>}
        {view && view.text === null && <p className="setting-hint">This file cannot be shown here. Open it from its folder.</p>}
        {view?.text && (markdown
          ? <div className="bubble-msg-body">{renderMarkdown(view.text)}</div>
          : <pre data-testid="artifact-sheet-text">{view.text}</pre>)}
      </div>
  </dialog>, document.body)
}
