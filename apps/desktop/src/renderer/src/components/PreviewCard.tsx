import { api } from '../api.js'
import { type CSSProperties, useCallback, useEffect, useId, useRef, useState } from 'react'
import { AppWindow, Calendar, ChevronUp, FileText, Globe, Mail, LoaderCircle, PanelRight, X } from 'lucide-react'
import { threadWords, type ThreadLang } from '../lib/threadLang.js'
import { GROUP_KO } from '../lib/threadLangKo.js'
import { useWebPane, webPane } from '../lib/webPane.js'
import { FrameScreen } from './FrameScreen.js'
import type { PreviewFrame } from './usePreviewFrames.js'

export const FALLBACK_RATIO = 16 / 10
export type StageSize = { id: string; width: number; height: number }

export function recordStageSize(previous: StageSize | null, id: string, width: number, height: number): StageSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return previous
  if (previous && previous.id === id && previous.width === width && previous.height === height) return previous
  return { id, width, height }
}

export function stageRatio(size: StageSize | null, id: string): number {
  return size && size.id === id ? size.width / size.height : FALLBACK_RATIO
}

export function paintedSize(stage: ParentNode | null): [number, number] {
  const canvas = stage?.querySelector('canvas')
  return canvas ? [canvas.width, canvas.height] : [0, 0]
}

export function observeChatCap(stage: Element, onCap: (cap: number) => void): () => void {
  const chat = stage.closest('.bots-chat, .mini-chat')
  if (!chat) return () => {}
  let last = -1
  const measure = (): void => {
    const cap = Math.round(chat.getBoundingClientRect().height / 2)
    // A hidden chat measures 0; keeping the last cap stops the drag fitter from locking the stage at 0px.
    if (cap > 0 && cap !== last) { last = cap; onCap(cap) }
  }
  measure()
  const observer = new ResizeObserver(measure)
  observer.observe(chat)
  return () => observer.disconnect()
}

export function PreviewCard({ frame, busy, state, lang, lane, compact, onOpenWeb, onCollapse, onHide, onSnapshot }: {
  frame: PreviewFrame; busy: boolean; state: 'recorded' | 'stopped' | 'waiting'
  lang: ThreadLang; lane: string; compact: boolean; onOpenWeb?(): void
  onCollapse(): void; onHide(): void; onSnapshot?(id: string, image: string): void
}) {
  const words = threadWords(lang).workPreview
  const { attention } = useWebPane(lane)
  const description = useId()
  const [now, setNow] = useState(Date.now)
  const paints = useRef(new Map<string, number>())
  const stage = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<StageSize | null>(null)
  const record = useCallback((width: number, height: number) => setSize(previous => recordStageSize(previous, frame.id, width, height)), [frame.id])
  const onPaint = useCallback((image: string) => {
    record(...paintedSize(stage.current))
    paints.current.set(frame.id, Date.now()); onSnapshot?.(frame.id, image); frame.onPaint?.()
  }, [frame.id, frame.onPaint, onSnapshot, record])
  // Set on the element, not through state: the drag fitter measures in the same ResizeObserver pass, before React would re-render.
  useEffect(() => {
    const node = stage.current
    return node ? observeChatCap(node, cap => node.style.setProperty('--pc-stage-cap', `${cap}px`)) : undefined
  }, [])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const Icon = frame.phase === 'activity' ? frame.title === 'Outlook' ? frame.activity === 'Checking your calendar' ? Calendar : Mail : FileText : frame.source === 'web' ? Globe : AppWindow
  const title = frame.title || words.browser
  const status = state === 'waiting' || attention ? 'waiting' : busy ? 'working' : state
  const age = Math.max(0, Math.floor((now - (paints.current.get(frame.id) ?? frame.at)) / 1000))
  const hasImage = frame.image && (frame.phase === 'ready' || frame.phase === 'delayed')
  const snapshot = `${words.lastSnapshot} · ${words.snapshotAge(age)}`
  const activity = frame.activity && (lang === 'ko' ? GROUP_KO[frame.activity] ?? frame.activity : frame.activity)
  const message = frame.connecting ? words.firstFrame : frame.phase === 'activity' ? words.officeActivity : frame.phase === 'empty' ? words.noSite : frame.phase === 'no-snapshot' ? words.noSnapshot
    : frame.reason === 'screen_recording_denied' ? words.screenPermission : frame.reason === 'capture_unsafe' ? words.captureUnsafe
    : frame.phase === 'unavailable' ? words.unavailable : words.firstFrame
  const open = () => {
    if (onOpenWeb) onOpenWeb(); else if (compact) webPane.expand(lane, true); else webPane.open(lane)
    if (frame.phase === 'empty') requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="live-address"]')?.focus())
  }
  return <aside className="preview-card" data-testid="preview-card" data-source={frame.source} data-lane={lane} aria-label={words.title} aria-describedby={description}>
    <div ref={stage} className="preview-card-stage" data-phase={frame.phase} title={snapshot} style={{ '--pc-ratio': stageRatio(size, frame.id) } as CSSProperties}>
      <span id={description} className="sr-only">{words.description}</span>
      {hasImage ? <img src={frame.image} alt={title} onLoad={event => record(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} /> : (frame.stream || frame.source === 'web') && frame.phase !== 'empty' ? <FrameScreen key={frame.id} lane={lane} source={frame.stream} title={title} onPaint={onPaint} /> : null}
      {!hasImage && <div className="preview-card-state"><Icon size={16} aria-hidden /><span>{message}</span></div>}
      <div className="preview-card-actions">
        {!!frame.hiddenByEngram && <button type="button" aria-label={words.showApp} title={words.showApp} onClick={() => { void api.desktopShowApp(lane).catch(() => {}) }}><AppWindow size={14} aria-hidden /></button>}
        {frame.source === 'web' && <button type="button" aria-label={compact ? words.openFull : words.openBeside} title={compact ? words.openFull : words.openBeside} onClick={open}><PanelRight size={14} aria-hidden /></button>}
        <button type="button" aria-label={words.collapse} title={words.collapse} aria-expanded onClick={onCollapse}><ChevronUp size={14} aria-hidden /></button>
        <button type="button" aria-label={words.hide} title={words.hide} onClick={onHide}><X size={14} aria-hidden /></button>
      </div>
      <div className="preview-card-caption">
        {status === 'working' ? <LoaderCircle size={12} className="computer-spinner" aria-hidden /> : <Icon size={12} aria-hidden />}
        <span className="preview-card-label" role="status">{frame.hiddenByEngram ? `${words.runningHidden} · ${title}${status === 'waiting' ? ` · ${words.waiting}` : ''}` : `${title} · ${frame.current && activity && status !== 'waiting' ? activity : words[status]}`}</span>
        {frame.stream && (busy || frame.live || frame.reconnecting) && (frame.live !== false || frame.reconnecting || hasImage) && <span className="preview-card-stale">{frame.live === false ? frame.reconnecting ? words.reconnecting : `${words.stoppedFrame} · ${new Date(frame.at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', hour12: false })}` : words.live}</span>}
        {(!frame.stream || !busy && !frame.live && !frame.reconnecting) && (hasImage || paints.current.has(frame.id)) && <span className="preview-card-stale">{frame.phase === 'delayed' ? words.delayed : snapshot}</span>}
      </div>
    </div>
  </aside>
}
