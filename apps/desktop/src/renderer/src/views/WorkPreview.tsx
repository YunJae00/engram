import { useEffect, useState, type CSSProperties } from 'react'
import type { WorkPreviewDto } from '../../../shared/desktop.js'
import { api } from '../api.js'

if (typeof document !== 'undefined') {
  document.getElementById('boot')?.remove()
  document.body.classList.add('work-preview-host')
}

export function WorkPreview() {
  const [frames, setFrames] = useState<WorkPreviewDto[]>([])
  useEffect(() => api.onEvent(event => { if (event.type === 'desktop:preview') setFrames(event.frames) }), [])
  return <aside className="work-preview" aria-label="Engram">
    {frames.map((frame, depth) => <figure key={frame.id} className="work-preview-card" style={{ '--depth': depth } as CSSProperties}>
      <figcaption><span className="work-preview-dot" /><span className="work-preview-title">{frame.title}</span></figcaption>
      {frame.data ? <img src={frame.data} alt={frame.title} onLoad={event => {
        const image = event.currentTarget
        image.closest('figure')?.style.setProperty('--preview-width', `${Math.max(138, Math.min(224, 230 * image.naturalWidth / image.naturalHeight))}px`)
      }} /> : <div className="work-preview-placeholder">Engram</div>}
    </figure>)}
  </aside>
}
