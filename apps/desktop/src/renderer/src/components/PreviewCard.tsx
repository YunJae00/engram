import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AppWindow, Calendar, ChevronUp, FileText, Globe, Mail, LoaderCircle, PanelRight, X } from 'lucide-react'
import { threadWords, type ThreadLang } from '../lib/threadLang.js'
import { GROUP_KO } from '../lib/threadLangKo.js'
import { useWebPane, webPane } from '../lib/webPane.js'
import { FrameScreen } from './FrameScreen.js'
import { setAppPreviewVisible } from '../lib/appPreviewStream.js'
import type { PreviewFrame } from './usePreviewFrames.js'

const preferences = new Map<string, { collapsed: boolean; hidden: boolean }>()
export function PreviewCard({ frames, busy, state, lang, lane, compact, onOpenWeb }: {
  frames: PreviewFrame[]; busy: boolean; state: 'recorded' | 'stopped' | 'waiting'
  lang: ThreadLang; lane: string; compact: boolean; onOpenWeb?(): void
}) {
  const words = threadWords(lang).workPreview
  const { attention } = useWebPane(lane)
  const description = useId()
  const [view, setView] = useState(() => preferences.get(lane) ?? { collapsed: false, hidden: false })
  const [choice, setChoice] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const paints = useRef(new Map<string, number>())
  const newest = [...frames].sort((a, b) => (paints.current.get(b.id) ?? b.at) - (paints.current.get(a.id) ?? a.at))[0]
  const frame = frames.find(frame => frame.id === choice) ?? newest
  const onPaint = useCallback(() => { if (frame) { paints.current.set(frame.id, Date.now()); frame.onPaint?.() } }, [frame?.id])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    setView(preferences.get(lane) ?? { collapsed: false, hidden: false })
  }, [lane])
  useEffect(() => {
    if (choice && !frames.some(frame => frame.id === choice)) setChoice(undefined)
  }, [choice, frames])
  const change = (next: typeof view) => { preferences.set(lane, next); setView(next) }
  const collapsed = view.collapsed
  useEffect(() => {
    setAppPreviewVisible(lane, Boolean(frame) && !view.hidden && !collapsed, busy)
  }, [lane, Boolean(frame), view.hidden, collapsed, busy])
  useEffect(() => () => setAppPreviewVisible(lane, false), [lane])
  if (!frame) return null
  const Icon = frame.phase === 'activity' ? frame.title === 'Outlook' ? frame.activity === 'Checking your calendar' ? Calendar : Mail : FileText : frame.source === 'web' ? Globe : AppWindow
  const title = frame.title || words.browser
  const status = state === 'waiting' || attention ? 'waiting' : busy ? 'working' : state
  const age = Math.max(0, Math.floor((now - (paints.current.get(frame.id) ?? frame.at)) / 1000))
  const hasImage = frame.image && (frame.phase === 'ready' || frame.phase === 'delayed')
  const snapshot = `${words.lastSnapshot} · ${words.snapshotAge(age)}`
  const activity = frame.activity && (lang === 'ko' ? GROUP_KO[frame.activity] ?? frame.activity : frame.activity)
  const message = frame.phase === 'activity' ? words.officeActivity : frame.phase === 'empty' ? words.noSite : frame.phase === 'no-snapshot' ? words.noSnapshot
    : frame.reason === 'screen_recording_denied' ? words.screenPermission : frame.reason === 'capture_unsafe' ? words.captureUnsafe
    : frame.phase === 'unavailable' ? words.unavailable : words.firstFrame
  const open = () => {
    if (onOpenWeb) onOpenWeb(); else if (compact) webPane.expand(lane, true); else webPane.open(lane)
    if (frame.phase === 'empty') requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="live-address"]')?.focus())
  }
  if (view.hidden) return <button type="button" className="preview-card-reopen" data-testid="preview-card-reopen" title={words.show} aria-label={words.show} onClick={() => change({ collapsed: false, hidden: false })}><Icon size={12} aria-hidden />{words.show}</button>
  if (collapsed) return <button type="button" className="preview-card-reopen" data-testid="preview-card-collapsed" data-lane={lane} data-source={frame.source} title={words.expand} aria-label={words.expand} aria-expanded={false} onClick={() => change({ ...view, collapsed: false })}><Icon size={12} aria-hidden />{title} · {words[status]}</button>
  return <aside className="preview-card" data-testid="preview-card" data-source={frame.source} data-lane={lane} aria-label={words.title} aria-describedby={description}>
    <div className="preview-card-stage" data-phase={frame.phase} title={snapshot}>
      <span id={description} className="sr-only">{words.description}</span>
      {hasImage ? <img src={frame.image} alt={title} /> : (frame.stream || frame.source === 'web') && frame.phase !== 'empty' ? <FrameScreen key={frame.id} lane={lane} source={frame.stream} title={title} onPaint={onPaint} /> : null}
      {!hasImage && <div className="preview-card-state"><Icon size={16} aria-hidden /><span>{message}</span></div>}
      <div className="preview-card-actions">
        {frame.source === 'web' && <button type="button" aria-label={compact ? words.openFull : words.openBeside} title={compact ? words.openFull : words.openBeside} onClick={open}><PanelRight size={14} aria-hidden /></button>}
        <button type="button" aria-label={words.collapse} title={words.collapse} aria-expanded onClick={() => change({ ...view, collapsed: true })}><ChevronUp size={14} aria-hidden /></button>
        <button type="button" aria-label={words.hide} title={words.hide} onClick={() => change({ ...view, hidden: true })}><X size={14} aria-hidden /></button>
      </div>
      <div className="preview-card-caption">
        {frames.length > 1 && <nav className="preview-card-dots" role="tablist" aria-label={words.choose}>{frames.map(item => <button type="button" key={item.id} role="tab" aria-label={item.title || words.browser} aria-selected={item.id === frame.id} tabIndex={item.id === frame.id ? 0 : -1} title={item.title || words.browser} onClick={() => setChoice(item.id)} onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const next = frames[(frames.findIndex(item => item.id === frame.id) + (event.key === 'ArrowRight' ? 1 : -1) + frames.length) % frames.length]!
          setChoice(next.id)
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[frames.indexOf(next)]?.focus()
        }} />)}</nav>}
        {status === 'working' ? <LoaderCircle size={12} className="computer-spinner" aria-hidden /> : <Icon size={12} aria-hidden />}
        <span className="preview-card-label" role="status">{title} · {frame.current && activity && status !== 'waiting' ? activity : words[status]}</span>
        {frame.stream && busy && <span className="preview-card-stale">{words.live}</span>}
        {(!frame.stream || !busy) && (hasImage || paints.current.has(frame.id)) && <span className="preview-card-stale">{frame.phase === 'delayed' ? words.delayed : snapshot}</span>}
      </div>
    </div>
  </aside>
}
