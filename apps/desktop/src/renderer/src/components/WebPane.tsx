import { ChevronsRight, LoaderCircle, Maximize2, PanelLeft, PictureInPicture2, Square } from 'lucide-react'
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
import { useCompactBrowser } from '../lib/useCompactBrowser.js'

const WIDTH_KEY = 'engram.webpane.width'
const MIN_W = 380
const MAX_SHARE = 0.72
const FOLD_MS = 220
const DEFAULT_SHARE = 0.52

function BrowserAddress({ url, channel }: { url?: string; channel: string }) {
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
      data-testid="live-address"
      aria-label="Website address"
      placeholder="Search or type a URL"
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
    />{pending && <LoaderCircle size={14} className="computer-spinner" aria-label="Opening website" />}</div>
  )
}

function BrowserStart() {
  return <div className="web-pane-empty browser-start" aria-hidden />
}

export function WebPane({ channel, busy, onStop, children, toolbar }: { channel: string; busy: boolean; onStop(): void; children?: ReactNode; toolbar?: ReactNode }) {
  const native = useNativeBrowser()
  const { activity } = useShellState()
  const active = activity === 'bots'
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => { setVisible(document.visibilityState === 'visible') }, [active])
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  const { folded, wanted, phase, expanded, floating } = useWebPane(channel)
  const { compact, elementRef } = useCompactBrowser()
  const preview = floating || (compact && !expanded)
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
  const mine = lane === channel
  const liveHere = on && mine
  const frameHere = frame && mine
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 0)
  const showing = liveHere && visible && active && !folded
  useEffect(() => {
    if (!showing) return
    agentMirror.showPixels(true)
    return () => agentMirror.showPixels(false)
  }, [showing])
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
  const stage = useRef<HTMLDivElement>(null)
  const frozen = !on && frameHere
  const paneShown = (liveHere || frozen) && !folded
  useBrowserViewport(stage, channel, Boolean(paneShown) && !native && active && !preview)
  if ((!liveHere && !frozen && !wanted) || (on && !mine && !wanted && !frozen)) return null
  if (preview) return null
  if (folded && !present) return null
  return (
    <aside
      className={`web-pane${frozen ? ' frozen' : ''}${closing ? ' closing' : ''}${expanded ? ' expanded' : ''}`}
      data-testid="web-pane"
      data-work={busy ? phase : 'idle'}
      ref={(element) => { elementRef(element); if (element) element.inert = closing }}
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
          <button className="live-dock-act" aria-label={t('live.small')} title={t('live.small')} onClick={() => webPane.preview(channel)}><PictureInPicture2 size={15} aria-hidden /></button>
          <button className="live-dock-act" data-testid="web-pane-expand" aria-label={t(expanded ? 'live.beside' : 'live.bigger')} title={t(expanded ? 'live.beside' : 'live.bigger')} onClick={() => webPane.expand(channel, !expanded)}>{expanded ? <PanelLeft size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}</button>
          {busy && (
            <button className="web-pane-stop" data-testid="web-pane-stop" onClick={onStop}>
              <Square size={10} strokeWidth={2.5} aria-hidden /> {t('bubble.stop')}
            </button>
          )}
        </div>
        <div className="web-work-status" data-testid="web-work-status" role="status" aria-live="polite" aria-hidden={!busy || phase === 'idle'}>
          <div><Comet size={15} /><strong>{t(phase === 'aside' ? 'live.yours' : 'live.working')}</strong><span>{t(phase === 'aside' ? 'live.yoursHint' : 'live.takeOverHint')}</span></div>
        </div>
        <div
          className="web-pane-stage"
          ref={stage}
        >
          {(!liveHere && !frameHere) || (mine && url === 'about:blank') ? <BrowserStart /> : native ? <NativeSurface key={channel} lane={channel} active={liveHere && !closing && active} /> : <MirrorSurface key={channel} lane={channel} live={liveHere && !closing && active} hasFrame={frameHere} />}
        </div>
        {frozen && <div className="web-pane-note">{t('live.closed')}</div>}
        {children}
      </div>
    </aside>
  )
}
