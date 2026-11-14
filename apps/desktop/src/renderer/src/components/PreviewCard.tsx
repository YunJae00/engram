import { api } from '../api.js'
import { type CSSProperties, useCallback, useEffect, useId, useReducer, useRef, useState } from 'react'
import { AppWindow, Calendar, ChevronUp, FileSpreadsheet, FileText, Globe, Mail, LoaderCircle, PanelRight, Presentation, X } from 'lucide-react'
import { threadWords, type ThreadLang } from '../lib/threadLang.js'
import { GROUP_KO } from '../lib/threadLangKo.js'
import { useWebPane, webPane } from '../lib/webPane.js'
import { FALLBACK_RATIO, HOLD_MS, heldLayers, recallPaint, rememberPaint, shownRatio } from '../lib/previewMotion.js'
import { FrameScreen } from './FrameScreen.js'
import type { PreviewFrame } from './usePreviewFrames.js'

export { FALLBACK_RATIO, recordStageSize, stageRatio, type StageSize } from '../lib/previewMotion.js'

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

export function previewIcon(frame: Pick<PreviewFrame, 'phase' | 'title' | 'activity' | 'source'>) {
  if (frame.phase !== 'activity') return frame.source === 'web' ? Globe : AppWindow
  if (frame.title === 'Outlook') return frame.activity === 'Checking your calendar' ? Calendar : Mail
  return frame.title === 'Excel' ? FileSpreadsheet : frame.title === 'PowerPoint' ? Presentation : FileText
}

export function PreviewCard({ frame, busy, state, lang, lane, compact, onOpenWeb, onCollapse, onHide }: {
  frame: PreviewFrame; busy: boolean; state: 'recorded' | 'stopped' | 'waiting'
  lang: ThreadLang; lane: string; compact: boolean; onOpenWeb?(): void
  onCollapse(): void; onHide(): void
}) {
  const words = threadWords(lang).workPreview
  const { attention } = useWebPane(lane)
  const description = useId()
  const [now, setNow] = useState(Date.now)
  const paints = useRef(new Map<string, number>())
  const stage = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLElement>(null)
  const [, repaint] = useReducer((count: number) => count + 1, 0)
  const size = recallPaint(lane, frame.id)?.size
  const shown = useRef(size)
  // Compared with what this card rendered, not with the memory: another card of the same lane may have recorded the size first.
  const record = useCallback((width: number, height: number, image?: string) => {
    rememberPaint(lane, frame.id, width, height, image)
    if (recallPaint(lane, frame.id)?.size !== shown.current) repaint()
  }, [lane, frame.id])
  const onPaint = useCallback((image: string) => {
    record(...paintedSize(stage.current), image)
    paints.current.set(frame.id, Date.now()); frame.onPaint?.()
  }, [frame.id, frame.onPaint, record])
  const lastRatio = useRef(FALLBACK_RATIO)
  const ratio = shownRatio(size, frame.id, lastRatio.current)
  useEffect(() => { lastRatio.current = ratio; shown.current = size })
  const hasImage = frame.image && (frame.phase === 'ready' || frame.phase === 'delayed')
  const front = hasImage ? 'img' : (frame.stream || frame.source === 'web') && frame.phase !== 'empty' ? 'canvas' : 'none'
  const kind = `${frame.id}\n${front}`
  const [held, setHeld] = useState(() => ({ kind, id: frame.id, own: recallPaint(lane, frame.id)?.image, previous: undefined as string | undefined }))
  if (held.kind !== kind) setHeld({ kind, id: frame.id, own: recallPaint(lane, frame.id)?.image, previous: held.id === frame.id ? undefined : recallPaint(lane, held.id)?.image })
  // Another app's picture never outlives a front that fails to paint.
  useEffect(() => {
    const timer = setTimeout(() => setHeld(one => one.previous ? { ...one, previous: undefined } : one), HOLD_MS)
    return () => clearTimeout(timer)
  }, [held.kind])
  // Set on the element, not through state: the drag fitter measures in the same ResizeObserver pass, before React would re-render.
  useEffect(() => {
    const node = card.current
    return node ? observeChatCap(node, cap => node.style.setProperty('--pc-stage-cap', `${cap}px`)) : undefined
  }, [])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const Icon = previewIcon(frame)
  const title = frame.title || words.browser
  const status = state === 'waiting' || attention ? 'waiting' : busy ? 'working' : state
  const age = Math.max(0, Math.floor((now - (paints.current.get(frame.id) ?? frame.at)) / 1000))
  const snapshot = `${words.lastSnapshot} · ${words.snapshotAge(age)}`
  const activity = frame.activity && (lang === 'ko' ? GROUP_KO[frame.activity] ?? frame.activity : frame.activity)
  const message = frame.connecting ? words.firstFrame : frame.phase === 'activity' ? words.officeActivity : frame.phase === 'empty' ? words.noSite : frame.phase === 'no-snapshot' ? words.noSnapshot
    : frame.reason === 'screen_recording_denied' ? words.screenPermission : frame.reason === 'capture_unsafe' ? words.captureUnsafe
    : frame.phase === 'unavailable' ? words.unavailable : words.firstFrame
  const open = () => {
    if (onOpenWeb) onOpenWeb(); else if (compact) webPane.expand(lane, true); else webPane.open(lane)
    if (frame.phase === 'empty') requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="live-address"]')?.focus())
  }
  return <aside ref={card} className="preview-card" style={{ '--pc-ratio': ratio } as CSSProperties} data-testid="preview-card" data-source={frame.source} data-lane={lane} aria-label={words.title} aria-describedby={description}>
    <div ref={stage} className="preview-card-stage" data-phase={frame.phase} title={snapshot}>
      <span id={description} className="sr-only">{words.description}</span>
      {heldLayers(frame.phase, front, held.own, held.previous).map(layer => <div key={`${layer.key}:${held.kind}`} className="preview-card-held" data-layer={layer.key} style={{ backgroundImage: `url("${layer.image}")` }} aria-hidden />)}
      {front === 'img' ? <img key={frame.id} src={frame.image} alt={title} onLoad={event => record(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight, frame.image)} /> : front === 'canvas' ? <FrameScreen key={frame.id} keep lane={lane} source={frame.stream} title={title} onPaint={onPaint} /> : null}
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
