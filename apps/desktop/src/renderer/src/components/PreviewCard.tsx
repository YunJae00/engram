import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AppWindow, ChevronDown, ChevronUp, Globe, LoaderCircle, PanelRight, X } from 'lucide-react'
import { threadWords, type ThreadLang } from '../lib/threadLang.js'
import { useWebPane, webPane } from '../lib/webPane.js'
import { FrameScreen } from './FrameScreen.js'
import type { PreviewFrame } from './usePreviewFrames.js'

const preferences = new Map<string, { collapsed: boolean; hidden: boolean }>()
export function PreviewCard({ frames, busy, state, lang, lane, compact, onOpenWeb }: {
  frames: PreviewFrame[]; busy: boolean; state: 'recorded' | 'stopped' | 'waiting'
  lang: ThreadLang; lane: string; compact: boolean; onOpenWeb?(): void
}) {
  const words = threadWords(lang).workPreview
  const { attention } = useWebPane(lane)
  const description = useId()
  const [view, setView] = useState(() => preferences.get(lane) ?? { collapsed: !busy, hidden: false })
  const [choice, setChoice] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const paints = useRef(new Map<string, number>())
  const newest = [...frames].sort((a, b) => (paints.current.get(b.id) ?? b.at) - (paints.current.get(a.id) ?? a.at))[0]
  const frame = frames.find(frame => frame.id === choice) ?? newest
  const onPaint = useCallback(() => { if (frame) paints.current.set(frame.id, Date.now()) }, [frame?.id])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (busy && preferences.has(lane)) return
    setView(before => ({ ...before, collapsed: !busy }))
  }, [busy, lane])
  const change = (next: typeof view) => { preferences.set(lane, next); setView(next) }
  if (!frame) return null
  const Icon = frame.source === 'web' ? Globe : AppWindow
  const title = frame.title || words.browser
  const collapsed = view.collapsed || state === 'waiting' || Boolean(attention)
  const status = state === 'waiting' || attention ? 'waiting' : busy ? 'working' : state
  const age = Math.max(0, Math.floor((now - (paints.current.get(frame.id) ?? frame.at)) / 1000))
  const snapshot = `${words.lastSnapshot} · ${words.snapshotAge(age)}`
  const message = frame.phase === 'empty' ? words.noSite : frame.phase === 'no-snapshot' ? words.noSnapshot
    : frame.reason === 'screen_recording_denied' ? words.screenPermission : frame.reason === 'capture_unsafe' ? words.captureUnsafe
    : frame.phase === 'unavailable' ? words.unavailable : words.firstFrame
  const open = () => {
    if (onOpenWeb) onOpenWeb(); else if (compact) webPane.expand(lane, true); else webPane.open(lane)
    if (frame.phase === 'empty') requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="live-address"]')?.focus())
  }
  if (view.hidden) return <button type="button" className="preview-card-reopen" data-testid="preview-card-reopen" title={words.show} aria-label={words.show} onClick={() => change({ collapsed: false, hidden: false })}><Icon size={12} aria-hidden />{words.show}</button>
  return <aside className={`preview-card${collapsed ? ' collapsed' : ''}`} data-testid="preview-card" data-source={frame.source} data-lane={lane} data-collapsed={collapsed} aria-label={words.title} aria-describedby={description}>
    <span id={description} className="sr-only">{words.description}</span>
    <header className="preview-card-bar">
      <Icon size={14} strokeWidth={1.75} aria-hidden />
      <span className="preview-card-title" title={title}>{title}</span>
      {collapsed && frames.length > 1 && <span className="preview-card-count">+{frames.length - 1}</span>}
      <small className={`preview-card-status ${status}`} role="status" aria-label={words[status]}>
        {status === 'working' ? <LoaderCircle size={10} className="computer-spinner" aria-hidden /> : <i aria-hidden />}
        <span>{words[status]}</span>
      </small>
      {frame.source === 'web' && <button type="button" aria-label={compact ? words.openFull : words.openBeside} title={compact ? words.openFull : words.openBeside} onClick={open}><PanelRight size={14} aria-hidden /></button>}
      <button type="button" aria-label={collapsed ? words.expand : words.collapse} title={collapsed ? words.expand : words.collapse} aria-expanded={!collapsed} onClick={() => change({ ...view, collapsed: !collapsed })}>{collapsed ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}</button>
      <button type="button" aria-label={words.hide} title={words.hide} onClick={() => change({ ...view, hidden: true })}><X size={14} aria-hidden /></button>
    </header>
    {!collapsed && <>
      {frames.length > 1 && <nav className="preview-card-tabs" role="tablist" aria-label={words.choose}>{frames.map((item, index) => {
        const SourceIcon = item.source === 'web' ? Globe : AppWindow
        return <button type="button" key={item.id} role="tab" aria-selected={item.id === frame.id} tabIndex={item.id === frame.id ? 0 : -1} title={item.title || words.browser} onClick={() => setChoice(item.id)} onKeyDown={event => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          setChoice(frames[(index + (event.key === 'ArrowRight' ? 1 : -1) + frames.length) % frames.length]!.id)
        }}><SourceIcon size={12} aria-hidden /><span>{item.title || words.browser}</span></button>
      })}</nav>}
      <div className="preview-card-stage" title={snapshot}>
        {frame.image ? <img src={frame.image} alt={title} /> : frame.source === 'web' && frame.phase !== 'empty' && frame.phase !== 'unavailable' ? <FrameScreen key={frame.id} lane={lane} source={frame.stream} title={title} onPaint={onPaint} /> : null}
        {!frame.image && <div className="preview-card-state">{busy && frame.phase === 'waiting' && <LoaderCircle size={12} className="computer-spinner" aria-hidden />}{message}</div>}
        {(frame.phase === 'delayed' || (busy && age >= 5)) && (frame.image || paints.current.has(frame.id)) && <span className="preview-card-stale">{frame.phase === 'delayed' ? words.delayed : snapshot}</span>}
      </div>
    </>}
  </aside>
}
