import { useEffect, useState, type CSSProperties } from 'react'
import { AppWindow, ChevronDown, ChevronUp, X } from 'lucide-react'
import type { WorkPreviewDto } from '../../../shared/desktop.js'
import { api } from '../api.js'
import { threadWords, type ThreadLang } from '../lib/threadLang.js'

const preferences = new Map<string, { collapsed: boolean; hidden: boolean }>()
export function WorkPreview({ lane, busy, state = 'recorded', lang = 'en' }: {
  lane: string; busy: boolean; state?: 'recorded' | 'stopped' | 'waiting'; lang?: ThreadLang
}) {
  const [frames, setFrames] = useState<WorkPreviewDto[]>([])
  const [now, setNow] = useState(Date.now)
  const [choice, setChoice] = useState<string>()
  const [view, setView] = useState(() => preferences.get(lane) ?? { collapsed: !busy, hidden: false })
  const words = threadWords(lang).workPreview
  const status = (frame: WorkPreviewDto) => frame.captureState === 'waiting' ? words.firstFrame
    : frame.unavailable || frame.captureState === 'unavailable' ? words.unavailable
    : frame.captureState === 'delayed' && frame.current !== false ? words.delayed
    : busy && frame.current !== false && now - frame.at < 5000 ? words.recent
    : `${words.snapshot} · ${Math.max(0, Math.floor((now - frame.at) / 1000))}s`
  const change = (next: typeof view) => { preferences.set(lane, next); setView(next) }
  useEffect(() => {
    let alive = true, received = false
    const off = api.onEvent(event => {
      if (event.type === 'desktop:preview') { received = true; setFrames(event.frames.filter(frame => frame.lane === lane)) }
    })
    void api.desktopPreviews(lane).then(next => { if (alive && !received) setFrames(next.filter(frame => frame.lane === lane)) }).catch(() => {})
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { alive = false; off(); clearInterval(timer) }
  }, [lane])
  useEffect(() => {
    if (busy && preferences.has(lane)) return
    setView(before => ({ ...before, collapsed: !busy }))
  }, [busy, lane])
  if (!frames.length) return null
  if (view.hidden) return <button className="work-preview-reopen" data-testid="work-preview-reopen" onClick={() => change({ collapsed: false, hidden: false })}><AppWindow size={13} aria-hidden />{words.show}</button>
  const ordered = [...frames].sort((a, b) => Number(b.id === choice) - Number(a.id === choice))
  return <aside className={`work-preview${view.collapsed ? ' collapsed' : ''}`} data-testid="work-preview" data-lane={lane} aria-label={words.title}>
    <header className="work-preview-bar">
      <AppWindow size={14} aria-hidden /><span>{words.title}</span><small role="status">{busy ? words.working : words[state]}</small>
      <button aria-label={view.collapsed ? words.expand : words.collapse} aria-expanded={!view.collapsed} onClick={() => change({ ...view, collapsed: !view.collapsed })}>{view.collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
      <button aria-label={words.hide} onClick={() => change({ ...view, hidden: true })}><X size={14} /></button>
    </header>
    {!view.collapsed && <>
      <div className="work-preview-deck">
        {ordered.map((frame, depth) => <figure key={frame.id} className="work-preview-card" data-frame={frame.id} style={{ '--depth': depth } as CSSProperties}>
          <figcaption><span className="work-preview-title">{frame.title}</span><small>{status(frame)}</small></figcaption>
          {frame.data ? <img src={frame.data} alt={frame.title} /> : <div className="work-preview-placeholder">{status(frame)}</div>}
        </figure>)}
      </div>
      {frames.length > 1 && <nav className="work-preview-tabs" aria-label={words.choose}>{frames.map(frame => <button key={frame.id} aria-pressed={frame.id === ordered[0]?.id} onClick={() => setChoice(frame.id)}>{frame.title}</button>)}</nav>}
      <p className="work-preview-caption">{words.caption}</p>
    </>}
  </aside>
}
