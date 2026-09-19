import { ArrowRight, ChevronsRight, Globe, LoaderCircle, Maximize2, PanelLeft, Square } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { api } from '../api.js'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { useWebPane, webPane } from '../lib/webPane.js'
import { Comet } from './Icon.js'
import { MirrorSurface } from './MirrorSurface.js'
import { NativeSurface } from './NativeSurface.js'
import { useNativeBrowser } from '../lib/nativeSurfaces.js'
import { t } from '../i18n.js'
import { useShellState } from '../state-slices.js'
import { BrowserActions } from './BrowserActions.js'
import { useBrowserViewport } from '../lib/useBrowserViewport.js'
import { browserAddress } from '../lib/browser-start.js'

// The page the comet works on, standing beside the conversation as its own
// half of the screen. Trust comes from being able to SEE the work and stop
// it: the page is always in view, always live to the person's own clicks and
// keys, and the stop is on the pane itself. The divider drags; the pane folds
// to a sliver and comes back; a closed browser leaves its last picture up,
// dimmed, so the answer can still be read against it.

const WIDTH_KEY = 'engram.webpane.width'
const MIN_W = 380
const MAX_SHARE = 0.72
// How long the pane takes to leave when folded away.
const FOLD_MS = 220
// What the page gets of the window before anyone drags the divider.
const DEFAULT_SHARE = 0.52

export function BrowserAddress({ url, channel, start = false }: { url?: string; channel: string; start?: boolean }) {
  const { showToast } = useShellState()
  const [draft, setDraft] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const navigating = useRef(false)
  const field = useRef<HTMLInputElement>(null)
  const shown = draft ?? (url === 'about:blank' ? '' : (url ?? ''))
  useEffect(() => {
    if (document.activeElement !== field.current && field.current) field.current.scrollLeft = 0
  }, [url])
  const go = () => {
    if (navigating.current || !shown.trim()) return
    let address: string
    try { address = browserAddress(shown) }
    catch (error) { showToast(error instanceof Error ? error.message : String(error)); return }
    setDraft(address)
    navigating.current = true; setPending(true)
    void api.agentGo(address, channel).then(() => setDraft(value => value === address ? null : value)).catch((error: unknown) => showToast(error instanceof Error ? error.message : 'Could not open the website')).finally(() => { navigating.current = false; setPending(false) })
  }
  return (
    <div className="browser-address-field" aria-busy={pending}><input
      ref={field}
      className="live-address"
      data-testid={start ? 'browser-start-input' : 'live-address'}
      aria-label={start ? 'Search or type a URL' : 'Website address'}
      placeholder="Search or type a URL"
      autoFocus={start}
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={(event) => {
        const input = event.currentTarget
        requestAnimationFrame(() => {
          input.scrollLeft = 0
        })
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { setDraft(null); return }
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
        e.preventDefault()
        e.stopPropagation()
        go()
      }}
    />{start ? <button className="browser-start-go" aria-label="Search or open website" disabled={pending || !shown.trim()} onClick={go}>{pending ? <LoaderCircle size={16} className="computer-spinner" aria-label="Opening website" /> : <ArrowRight size={18} aria-hidden />}</button> : pending && <LoaderCircle size={14} className="computer-spinner" aria-label="Opening website" />}</div>
  )
}

export function BrowserStart({ channel }: { channel: string }) {
  return <div className="web-pane-empty browser-start"><Globe size={42} strokeWidth={1.2} aria-hidden /><h2>Where would you like to go?</h2><BrowserAddress channel={channel} start /><span>Search the web or enter a website. No AI connection needed.</span></div>
}

export function WebPane({ channel, busy, onStop, children, toolbar }: { channel: string; busy: boolean; onStop(): void; children?: ReactNode; toolbar?: ReactNode }) {
  const native = useNativeBrowser()
  const { activity } = useShellState()
  const active = activity === 'bots'
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  // Folding plays the pane out to the right edge before the tab takes its
  // place, so the fold reads as the pane leaving, not vanishing.
  const { folded, wanted, phase, expanded } = useWebPane(channel)
  useEffect(() => {
    if (busy && expanded) webPane.expand(channel, false)
  }, [busy, expanded, channel])
  const [present, setPresent] = useState(!folded)
  const closing = folded && present
  const fold = () => webPane.fold(channel)
  useEffect(() => {
    if (!folded) { setPresent(true); return }
    const timer = setTimeout(() => setPresent(false), window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : FOLD_MS)
    return () => clearTimeout(timer)
  }, [folded, channel])
  useEffect(() => {
    if (!active) return
    agentMirror.select(channel)
    void api.agentLane(channel).catch(() => {})
    void agentMirror.ask()
  }, [channel, active])
  const { on, url, frame, lane } = useSyncExternalStore(agentMirror.subscribe, agentMirror.getSnapshot)
  // What the store holds is whoever was mirrored last; it belongs on this
  // pane only when it is this comet's own. Another comet's page must never
  // stand in for an empty one here.
  const mine = lane === channel
  const liveHere = on && mine
  const frameHere = frame && mine
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 0)
  // Visible pages remain responsive even after the assistant finishes.
  // The compositor only streams changes; hidden panes have no encoder.
  const showing = liveHere && visible && active && !folded
  useEffect(() => {
    if (!showing) return
    agentMirror.showPixels(true)
    return () => agentMirror.showPixels(false)
  }, [showing])
  // A pane that has just opened, or a page that has just moved, is asked for
  // the picture as it is now rather than waiting for the page to paint.
  useEffect(() => {
    if (!showing || native) return
    void api.agentRefresh().catch(() => {})
  }, [showing, url, native])
  const drag = (down: React.MouseEvent) => {
    down.preventDefault()
    const fromX = down.clientX
    const started = width || Math.round(window.innerWidth * DEFAULT_SHARE)
    const move = (e: MouseEvent) => {
      const next = Math.max(MIN_W, Math.min(window.innerWidth * MAX_SHARE, started + (fromX - e.clientX)))
      setWidth(next)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setWidth((held) => {
        localStorage.setItem(WIDTH_KEY, String(held))
        return held
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // Match the visible pane so text stays readable without scaling a desktop
  // layout down to a narrow picture. Native surfaces already resize directly.
  const stage = useRef<HTMLDivElement>(null)
  const frozen = !on && frameHere
  const paneShown = (liveHere || frozen) && !folded
  useBrowserViewport(stage, channel, Boolean(paneShown) && !native && active)
  // Nothing live, nothing kept, and nobody asked: no panel. Asked for by
  // hand with nothing open, it stands with its address field - the way a
  // browser opens on a blank tab - and folded it is simply gone; the globe
  // by the composer is where it comes back.
  if ((!liveHere && !frozen && !wanted) || (on && !mine && !wanted && !frozen)) return null
  if (folded && !present) return null
  return (
    <aside
      className={`web-pane${frozen ? ' frozen' : ''}${closing ? ' closing' : ''}${expanded ? ' expanded' : ''}`}
      data-testid="web-pane"
      data-work={busy ? phase : 'idle'}
      ref={(element) => { if (element) element.inert = closing }}
      style={width ? ({ '--web-pane-width': `${width}px` } as CSSProperties) : undefined}
    >
      <div className="web-pane-grip" onMouseDown={drag} aria-hidden />
      <div className="web-pane-inner">
        {toolbar}
        <div className="web-pane-bar">
          <button
            className="live-dock-act"
            data-testid="web-pane-fold"
            aria-label={t('live.fold')}
            title={t('live.fold')}
            onClick={fold}
          >
            <ChevronsRight size={13} aria-hidden />
          </button>
          <BrowserAddress key={`address-${channel}`} channel={channel} url={mine ? url : ''} />
          <BrowserActions key={`actions-${channel}`} lane={channel} url={mine ? url : undefined} live={liveHere} />
          <button className="live-dock-act" data-testid="web-pane-expand" disabled={busy} aria-label={expanded ? 'Show chat beside browser' : 'Expand browser'} title={busy ? 'Chat stays visible while the AI is working' : expanded ? 'Show chat beside browser' : 'Expand browser'} onClick={() => webPane.expand(channel, !expanded)}>{expanded ? <PanelLeft size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}</button>
          {busy && (
            <button className="web-pane-stop" data-testid="web-pane-stop" onClick={onStop}>
              <Square size={10} strokeWidth={2.5} aria-hidden /> {t('bubble.stop')}
            </button>
          )}
        </div>
        <div className="web-work-status" data-testid="web-work-status" role="status" aria-live="polite" aria-hidden={!busy || phase === 'idle'}>
          <div><Comet size={15} /><strong>{phase === 'aside' ? 'You have the page' : 'Comets at work'}</strong><span>{phase === 'aside' ? 'Comets will wait for you' : 'Click or type to take over'}</span></div>
        </div>
        {/* The picture keeps the page's own shape: the stage is exactly as
            tall as the frame is wide, so nothing is letterboxed inside a
            field and the space left over is simply the pane. */}
        <div
          className="web-pane-stage"
          ref={stage}
        >
          {(!liveHere && !frameHere) || (mine && url === 'about:blank') ? <BrowserStart channel={channel} /> : native ? <NativeSurface key={channel} lane={channel} active={liveHere && !closing && active} /> : <MirrorSurface key={channel} lane={channel} live={liveHere && !closing && active} hasFrame={frameHere} />}
        </div>
        {frozen && <div className="web-pane-note">{t('live.closed')}</div>}
        {children}
      </div>
    </aside>
  )
}
