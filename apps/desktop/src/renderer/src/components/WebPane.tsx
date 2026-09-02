import { AppWindow, ChevronsLeft, ChevronsRight, RotateCw, Square } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api } from '../api.js'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { MirrorSurface } from './MirrorSurface.js'
import { useApp } from '../state.js'

// The page the comet works on, standing beside the conversation as its own
// half of the screen. Trust comes from being able to SEE the work and stop
// it: the page is always in view, always live to the person's own clicks and
// keys, and the stop is on the pane itself. The divider drags; the pane folds
// to a sliver and comes back; a closed browser leaves its last picture up,
// dimmed, so the answer can still be read against it.

const WIDTH_KEY = 'engram.webpane.width'
const FOLD_KEY = 'engram.webpane.folded'
const MIN_W = 380
const MAX_SHARE = 0.72

function hostOf(url: string | undefined): string {
  if (!url || url === 'about:blank') return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function Address({ url }: { url?: string }) {
  const { t } = useApp()
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (url === 'about:blank' ? '' : (url ?? ''))
  return (
    <input
      className="live-address"
      data-testid="live-address"
      placeholder={t('live.address')}
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        const typed = shown.trim()
        if (!typed) return
        void api.agentGo(/^[a-z]+:/i.test(typed) ? typed : `https://${typed}`).catch(() => {})
        setDraft(null)
        e.currentTarget.blur()
      }}
    />
  )
}

export function WebPane({ busy, onStop, children }: { busy: boolean; onStop(): void; children?: ReactNode }) {
  const { t } = useApp()
  const { on, url, frame } = useSyncExternalStore(agentMirror.subscribe, agentMirror.getSnapshot)
  const [folded, setFolded] = useState(() => localStorage.getItem(FOLD_KEY) === '1')
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 0)
  const [windowOut, setWindowOut] = useState(false)
  // What is open, asked once when the pane first mounts: the last picture and
  // address survive a walk to another tab and back.
  useEffect(() => {
    void agentMirror.ask()
  }, [])
  // Frames flow only while the pane is actually showing the picture.
  const showing = on && !folded
  useEffect(() => {
    if (!showing) return
    agentMirror.showPixels(true)
    // A pane that has just opened onto a still page asks for the picture as
    // it is now rather than waiting for the page to move.
    void api.agentRefresh().catch(() => {})
    return () => agentMirror.showPixels(false)
  }, [showing])
  useEffect(() => {
    if (!on) setWindowOut(false)
  }, [on])
  const drag = (down: React.MouseEvent) => {
    down.preventDefault()
    const fromX = down.clientX
    const started = width || Math.round(window.innerWidth * 0.46)
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
  const frozen = !on && frame
  if (!on && !frozen) return null
  if (folded)
    return (
      <aside className="web-pane folded" data-testid="web-pane-folded">
        <button
          className="web-pane-unfold"
          data-testid="web-pane-unfold"
          aria-label={t('live.unfold')}
          title={t('live.unfold')}
          onClick={() => {
            localStorage.setItem(FOLD_KEY, '0')
            setFolded(false)
          }}
        >
          <ChevronsLeft size={14} aria-hidden />
        </button>
        <span className="web-pane-side-host">{frozen ? t('live.closed') : hostOf(url) || t('live.caption')}</span>
      </aside>
    )
  const host = hostOf(url)
  return (
    <aside
      className={`web-pane${frozen ? ' frozen' : ''}`}
      data-testid="web-pane"
      style={width ? { width } : undefined}
    >
      <div className="web-pane-grip" onMouseDown={drag} aria-hidden />
      <div className="web-pane-inner">
        <div className="web-pane-bar">
          <button
            className="live-dock-act"
            data-testid="web-pane-fold"
            aria-label={t('live.fold')}
            title={t('live.fold')}
            onClick={() => {
              localStorage.setItem(FOLD_KEY, '1')
              setFolded(true)
            }}
          >
            <ChevronsRight size={13} aria-hidden />
          </button>
          <Address url={url} />
          {!frozen && (
            <>
              <button className="live-dock-act" data-testid="live-refresh" aria-label={t('live.refresh')} title={t('live.refresh')} onClick={() => void api.agentRefresh().catch(() => {})}>
                <RotateCw size={13} aria-hidden />
              </button>
              <button
                className="live-dock-act"
                aria-label={t(windowOut ? 'live.hideWindow' : 'live.openWindow')}
                title={t(windowOut ? 'live.hideWindow' : 'live.openWindow')}
                onClick={() => {
                  const next = !windowOut
                  setWindowOut(next)
                  void api.agentWindow(next).catch(() => {})
                }}
              >
                <AppWindow size={13} aria-hidden />
              </button>
            </>
          )}
          {busy && (
            <button className="web-pane-stop" data-testid="web-pane-stop" onClick={onStop}>
              <Square size={10} strokeWidth={2.5} aria-hidden /> {t('bubble.stop')}
            </button>
          )}
        </div>
        <div className="web-pane-stage">
          <MirrorSurface live={on} hasFrame={frame} />
        </div>
        <div className="web-pane-note">{frozen ? t('live.closed') : host ? t('live.hint') : ''}</div>
        {children}
      </div>
    </aside>
  )
}
