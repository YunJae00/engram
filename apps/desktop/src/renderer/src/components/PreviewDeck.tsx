import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { usePreviewDrag } from '../lib/previewDrag.js'
import './live-overlay.css'
import { AppWindow } from 'lucide-react'
import { threadWords, type ThreadLang } from '../lib/threadLang.js'
import { useWebPane } from '../lib/webPane.js'
import { setAppPreviewVisible } from '../lib/appPreviewStream.js'
import { PreviewCard } from './PreviewCard.js'
import type { PreviewFrame } from './usePreviewFrames.js'

const preferences = new Map<string, { collapsed: boolean; hidden: boolean }>()
export function previewOrder(order: string[], frames: PreviewFrame[], selected?: string): string[] {
  const ids = new Set(frames.map(frame => frame.id))
  const kept = order.filter(id => ids.has(id))
  const added = frames.filter(frame => !order.includes(frame.id)).sort((a, b) => b.at - a.at).map(frame => frame.id)
  if (selected && kept.includes(selected)) return [selected, ...added, ...kept.filter(id => id !== selected)]
  return [...added, ...kept]
}
export function previewNeighbor(frames: PreviewFrame[], id: string, direction: number): string {
  return frames[(frames.findIndex(frame => frame.id === id) + direction + frames.length) % frames.length]!.id
}
export function previewAppVisible(frame: PreviewFrame | undefined, view: { hidden: boolean; collapsed: boolean }): boolean {
  return frame?.source === 'app' && frame.phase !== 'activity' && !view.hidden && !view.collapsed
}
export function PreviewDeck({ frames: all, busy, state, lang, lane, compact, onOpenWeb, active = true, overlay = false }: {
  frames: PreviewFrame[]; busy: boolean; state: 'recorded' | 'stopped' | 'waiting'
  lang: ThreadLang; lane: string; compact: boolean; onOpenWeb?(): void; active?: boolean; overlay?: boolean
}) {
  const presence = useId()
  const frames = busy ? all : all.filter(frame => frame.phase !== 'activity')
  const words = threadWords(lang).workPreview
  const { attention } = useWebPane(lane)
  const [view, setView] = useState(() => preferences.get(lane) ?? { collapsed: false, hidden: false })
  const [order, setOrder] = useState<string[]>([])
  const [selected, setSelected] = useState<string>()
  const surface = useRef<HTMLDivElement>(null)
  usePreviewDrag(surface, active && !view.hidden && !view.collapsed && frames.length > 0, lane, overlay)
  const images = useRef(new Map<string, string>())
  const ordered = previewOrder(order, frames, selected)
  const identity = ordered.join('\n')
  useEffect(() => { setOrder(ordered) }, [identity])
  useEffect(() => { setView(preferences.get(lane) ?? { collapsed: false, hidden: false }); setSelected(undefined); images.current.clear() }, [lane])
  const snapshot = useCallback((id: string, image: string) => { images.current.set(id, image) }, [])
  const frame = frames.find(frame => frame.id === ordered[0])
  const live = frames.some(item => previewAppVisible(item, view))
  useEffect(() => {
    const update = () => {
      setAppPreviewVisible(lane, live && active && document.visibilityState !== 'hidden', presence)
    }
    update(); document.addEventListener('visibilitychange', update)
    return () => { document.removeEventListener('visibilitychange', update); setAppPreviewVisible(lane, false, presence) }
  }, [lane, live, active, presence])
  useEffect(() => {
    if (selected && !frames.some(frame => frame.id === selected)) setSelected(undefined)
    for (const id of images.current.keys()) if (!frames.some(frame => frame.id === id)) images.current.delete(id)
  }, [identity])
  const change = (next: typeof view) => { preferences.set(lane, next); setView(next) }
  if (!frame) return null
  if (view.hidden || view.collapsed) return <button type="button" className="preview-card-reopen" data-testid={view.hidden ? 'preview-card-reopen' : 'preview-card-collapsed'} data-lane={lane} data-source={frame.source} aria-label={view.hidden ? words.show : words.expand} aria-expanded={false} onClick={() => change({ collapsed: false, hidden: false })}><AppWindow size={12} aria-hidden />{view.hidden ? words.show : `${frame.title || words.browser} · ${words[state === 'waiting' || attention ? 'waiting' : busy ? 'working' : state]}`}</button>
  return <div ref={surface} className={`preview-deck${overlay ? ' live-overlay-deck' : ''}`} style={{ '--deck-depth': Math.min(ordered.length - 1, 3) } as CSSProperties} data-testid="preview-deck" aria-label={words.choose} tabIndex={0} onKeyDown={event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setSelected(previewNeighbor(frames, frame.id, event.key === 'ArrowRight' ? 1 : -1))
  }}>
    {ordered.slice(0, 4).map((id, position) => {
      const item = frames.find(frame => frame.id === id)!
      const image = images.current.get(id) ?? item.image
      return <div key={id} className="preview-deck-card" data-position={position} data-frame={id} style={{ '--deck-position': position, zIndex: 4 - position } as CSSProperties}>
        {position === 0 ? <PreviewCard frame={item} busy={busy} state={state} lang={lang} lane={lane} compact={compact} onOpenWeb={onOpenWeb} onCollapse={() => change({ ...view, collapsed: true })} onHide={() => change({ ...view, hidden: true })} onSnapshot={snapshot} />
          : <button type="button" className="preview-deck-back" aria-label={item.title || words.browser} onClick={() => { setSelected(id); setOrder([id, ...ordered.filter(other => other !== id)]); surface.current?.focus() }}>{image ? <img src={image} alt="" /> : null}<span className="preview-deck-title">{item.title || words.browser}</span></button>}
      </div>
    })}
  </div>
}
