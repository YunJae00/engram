import { Globe, GripVertical, LoaderCircle, Maximize2, Minus, PanelLeft, PictureInPicture2, Square } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { api } from '../api.js'
import { webPane } from '../lib/webPane.js'
import { FrameScreen, type FrameSource } from './FrameScreen.js'

export function BrowserPreview({ channel, url, native, live, visible, minimized, busy, onStop, width, height }: {
  channel: string; url?: string; native: boolean; live: boolean; visible: boolean; minimized: boolean
  busy: boolean; onStop(): void; width: number; height: number
}) {
  const card = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<{ right: number; top: number } | null>(null)
  const [shape, setShape] = useState<{ width: number; height: number } | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const cached = useRef<string | null>(null)
  const dragFrom = useRef<{ x: number; y: number; right: number; top: number } | null>(null)
  const keepInside = useCallback((next: { right: number; top: number }) => {
    const parent = card.current?.offsetParent
    const rect = card.current?.getBoundingClientRect()
    if (!parent || !rect) return
    setPosition({ right: Math.max(12, Math.min(next.right, Math.max(12, parent.clientWidth - rect.width - 12))), top: Math.max(12, Math.min(next.top, Math.max(12, parent.clientHeight - rect.height - 100))) })
  }, [])
  useEffect(() => {
    const parent = card.current?.offsetParent
    if (!parent) return
    const observer = new ResizeObserver(() => {
      setPosition(before => {
        if (!before || !card.current) return before
        const next = { right: Math.max(12, Math.min(before.right, parent.clientWidth - card.current.offsetWidth - 12)), top: Math.max(12, Math.min(before.top, parent.clientHeight - card.current.offsetHeight - 100)) }
        return next.right === before.right && next.top === before.top ? before : next
      })
    })
    observer.observe(parent)
    if (card.current) observer.observe(card.current)
    return () => observer.disconnect()
  }, [])
  const source = useCallback<FrameSource>((paint) => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    if (cached.current) paint(cached.current)
    const refresh = async () => {
      const data = await api.nativeSnapshot(channel).catch(() => null)
      if (!alive) return
      if (data) {
        const base64 = data.slice(data.indexOf(',') + 1)
        cached.current = base64
        paint(base64)
        setUnavailable(false)
        const image = new Image()
        image.onload = () => { if (alive) setShape(before => before?.width === image.naturalWidth && before.height === image.naturalHeight ? before : { width: image.naturalWidth, height: image.naturalHeight }) }
        image.src = data
      } else setUnavailable(true)
      if (live) timer = setTimeout(() => void refresh(), 1000)
    }
    if (visible && !minimized && url && url !== 'about:blank') void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [channel, live, visible, minimized, url])
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    const rect = card.current?.getBoundingClientRect(), parent = card.current?.offsetParent?.getBoundingClientRect()
    if (!rect || !parent) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragFrom.current = { x: event.clientX, y: event.clientY, right: parent.right - rect.right, top: rect.top - parent.top }
  }
  let site = 'Browser'
  try { if (url && url !== 'about:blank') site = new URL(url).hostname } catch { /* Keep the generic title. */ }
  const size = native && shape ? shape : { width, height }
  return <aside ref={card} className={`browser-preview${minimized ? ' minimized' : ''}`} data-testid="web-pane" aria-label="Browser preview" style={position ? { right: position.right, top: position.top } : undefined}>
    <div className="browser-preview-bar" onPointerDown={drag} onPointerMove={event => {
      const from = dragFrom.current
      if (from) keepInside({ right: from.right + from.x - event.clientX, top: from.top + event.clientY - from.y })
    }} onPointerUp={() => { dragFrom.current = null }} onPointerCancel={() => { dragFrom.current = null }} onLostPointerCapture={() => { dragFrom.current = null }}>
      <GripVertical size={12} className="browser-preview-grip" aria-hidden />
      {busy ? <LoaderCircle size={14} className="computer-spinner" aria-label="Browser working" /> : <Globe size={14} aria-hidden />}
      <span className="browser-preview-title" title={site}>{site}</span>
      {minimized ? <button aria-label="Show browser preview" title="Show browser preview" onClick={() => webPane.preview(channel)}><PictureInPicture2 size={15} /></button> : <>
        <button aria-label="Show chat beside browser" title="Show chat beside browser" onClick={() => webPane.open(channel)}><PanelLeft size={15} /></button>
        <button aria-label="Expand browser" title="Expand browser" onClick={() => webPane.expand(channel, true)}><Maximize2 size={15} /></button>
        <button aria-label="Minimize preview" title="Minimize preview" onClick={() => webPane.fold(channel)}><Minus size={15} /></button>
      </>}
      {busy && <button className="browser-preview-stop" aria-label="Stop task" title="Stop task" onClick={onStop}><Square size={12} /></button>}
    </div>
    {!minimized && <button className="browser-preview-picture" aria-label="Open browser beside chat" onClick={() => webPane.open(channel)} style={{ aspectRatio: `${size.width} / ${size.height}` } as CSSProperties}>
      <FrameScreen key={channel} lane={channel} source={native ? source : undefined} />
      <span className="browser-preview-wait">{unavailable ? 'Preview unavailable · click to open' : 'Opening preview…'}</span>
      <span className="browser-preview-open"><PanelLeft size={13} aria-hidden /> Open browser</span>
    </button>}
  </aside>
}
