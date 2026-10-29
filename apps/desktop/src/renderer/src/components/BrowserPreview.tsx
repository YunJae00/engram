import { Globe, GripVertical, LoaderCircle, Maximize2, Minus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { api } from '../api.js'
import { webPane } from '../lib/webPane.js'
import { FrameScreen, type FrameSource } from './FrameScreen.js'

export function BrowserPreview({ channel, url, native, live, visible, busy, width, height, compact, elementRef, onOpen, frames }: {
  channel: string; url?: string; native: boolean; live: boolean; visible: boolean
  busy: boolean; width: number; height: number; compact: boolean; elementRef(element: HTMLElement | null): void
  // Where the page opens when the picture is chosen; by default the chat's own browser pane.
  onOpen?(): void
  // Pictures of a page drawn elsewhere, for a lane the shared mirror is not following.
  frames?: FrameSource
}) {
  const card = useRef<HTMLElement | null>(null)
  const [position, setPosition] = useState<{ right: number; top: number } | null>(null)
  const [shape, setShape] = useState<{ width: number; height: number } | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const cached = useRef<{ data: string; url?: string } | null>(null)
  // Reuse the canvas decode so resized frames never keep an old aspect ratio.
  const measureShape = useCallback((width: number, height: number) => setShape(before => before?.width === width && before.height === height ? before : { width, height }), [])
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
    if (cached.current && cached.current.url === url) paint(cached.current.data)
    const refresh = async () => {
      const data = await api.nativeSnapshot(channel).catch(() => null)
      if (!alive) return
      if (data) {
        const base64 = data.slice(data.indexOf(',') + 1)
        cached.current = { data: base64, url }
        paint(base64)
        setUnavailable(false)
      } else setUnavailable(true)
      if (live) timer = setTimeout(() => void refresh(), 1000)
    }
    if (visible && url && url !== 'about:blank') void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [channel, live, visible, url])
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
  const open = () => { if (onOpen) onOpen(); else if (compact) webPane.expand(channel, true); else webPane.open(channel) }
  return <aside ref={element => { card.current = element; elementRef(element) }} className={`browser-preview${minimized ? ' minimized' : ''}`} data-testid="web-pane" aria-label="Browser preview" style={position ? { right: position.right, top: position.top } : undefined}>
    <div className="browser-preview-bar" onPointerDown={drag} onPointerMove={event => {
      const from = dragFrom.current
      if (from) keepInside({ right: from.right + from.x - event.clientX, top: from.top + event.clientY - from.y })
    }} onPointerUp={() => { dragFrom.current = null }} onPointerCancel={() => { dragFrom.current = null }} onLostPointerCapture={() => { dragFrom.current = null }}>
      <GripVertical size={12} className="browser-preview-grip" aria-hidden />
      {busy ? <LoaderCircle size={14} className="computer-spinner" aria-label="Browser working" /> : <Globe size={14} aria-hidden />}
      <span className="browser-preview-title" title={site}>{site}</span>
      {!minimized && <button aria-label="Minimize browser" title="Minimize browser" onClick={() => setMinimized(true)}><Minus size={15} aria-hidden /></button>}
      <button aria-label={minimized ? 'Restore browser preview' : 'Expand browser'} title={minimized ? 'Restore browser preview' : 'Expand browser'} onClick={() => { if (minimized) setMinimized(false); else if (onOpen) onOpen(); else webPane.expand(channel, true) }}><Maximize2 size={15} aria-hidden /></button>
    </div>
    {!minimized && <button className="browser-preview-picture" aria-label={compact ? 'Open full browser' : 'Open browser beside chat'} onClick={open} style={{ aspectRatio: `${size.width} / ${size.height}` } as CSSProperties}>
      <FrameScreen key={channel} lane={channel} source={native || !url || url === 'about:blank' ? source : frames} onSize={measureShape} />
      <span className="browser-preview-wait">{(!url || url === 'about:blank') && !busy ? 'Click to enter a website' : unavailable ? 'Preview unavailable · click to open' : 'Opening preview…'}</span>
    </button>}
  </aside>
}
