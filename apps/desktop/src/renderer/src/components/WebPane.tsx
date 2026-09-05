import { ChevronsRight, RotateCw, Square, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { api } from '../api.js'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { webPane } from '../lib/webPane.js'
import { MirrorSurface } from './MirrorSurface.js'
import { t } from '../i18n.js'

// The page the comet works on, standing beside the conversation as its own
// half of the screen. Trust comes from being able to SEE the work and stop
// it: the page is always in view, always live to the person's own clicks and
// keys, and the stop is on the pane itself. The divider drags; the pane folds
// to a sliver and comes back; a closed browser leaves its last picture up,
// dimmed, so the answer can still be read against it.

const WIDTH_KEY = 'engram.webpane.width'
const MIN_W = 380
// How long a page keeps streaming after the person's last touch on it.
const HANDS_ON_MS = 4_000
const MAX_SHARE = 0.72
// The page's own width, fixed - the pane only ever changes its height.
const VIEW_WIDTH = 1280
// A drag settles before the pages are asked to lay out again.
const SETTLE_MS = 260
// How long the old picture takes to give way to the new comet's.
const SWITCH_MS = 240
// How long the pane takes to leave when folded away.
const FOLD_MS = 170
// What the page gets of the window before anyone drags the divider.
const DEFAULT_SHARE = 0.52

function hostOf(url: string | undefined): string {
  if (!url || url === 'about:blank') return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function Address({ url }: { url?: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const shown = draft ?? (url === 'about:blank' ? '' : (url ?? ''))
  useEffect(() => {
    if (document.activeElement !== field.current && field.current) field.current.scrollLeft = 0
  }, [url])
  return (
    <input
      ref={field}
      className="live-address"
      data-testid="live-address"
      placeholder={t('live.address')}
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={(event) => {
        const input = event.currentTarget
        setDraft(null)
        requestAnimationFrame(() => {
          input.scrollLeft = 0
        })
      }}
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

export function WebPane({ channel, busy, onStop, children }: { channel: string; busy: boolean; onStop(): void; children?: ReactNode }) {
  // The pane shows the tab of the comet being looked at, and moves with it:
  // the old picture fades while the new tab's picture is fetched, instead
  // of one page being swapped for another between two frames.
  const [switching, setSwitching] = useState(false)
  // Folding plays the pane out to the right edge before the tab takes its
  // place, so the fold reads as the pane leaving, not vanishing.
  const [closing, setClosing] = useState(false)
  const fold = () => {
    setClosing(true)
    window.setTimeout(() => {
      setClosing(false)
      webPane.fold()
    }, FOLD_MS)
  }
  useEffect(() => {
    setSwitching(true)
    void api.agentLane(channel).catch(() => {})
    const settle = setTimeout(() => setSwitching(false), SWITCH_MS)
    return () => clearTimeout(settle)
  }, [channel])
  const { on, url, frame } = useSyncExternalStore(agentMirror.subscribe, agentMirror.getSnapshot)
  const { folded, wanted } = useSyncExternalStore(webPane.subscribe, webPane.getSnapshot)
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 0)
  // What is open, asked once when the pane first mounts: the last picture and
  // address survive a walk to another tab and back.
  useEffect(() => {
    void agentMirror.ask()
  }, [])
  // A run of frames is a video encoder running: cheap for a moment, not
  // cheap all afternoon. The pane is on screen the whole time now, so frames
  // flow only while there is motion to carry - the comet working, or the
  // person's own hands on the page - and a still page is simply photographed
  // once. Everything else (a navigation, the refresh button, unfolding) asks
  // for its own picture.
  const [touched, setTouched] = useState(0)
  const handsOn = touched > Date.now() - HANDS_ON_MS
  const showing = on && !folded && (busy || handsOn)
  useEffect(() => {
    if (!showing) return
    agentMirror.showPixels(true)
    return () => agentMirror.showPixels(false)
  }, [showing])
  // A pane that has just opened, or a page that has just moved, is asked for
  // the picture as it is now rather than waiting for the page to paint.
  useEffect(() => {
    if (!on || folded) return
    void api.agentRefresh().catch(() => {})
  }, [on, folded, url])
  // The window closes on its own once the last touch is old enough; the
  // frame it leaves behind is refreshed so nothing stale is left on screen.
  useEffect(() => {
    if (!handsOn) return
    const until = setTimeout(() => {
      setTouched(0)
      void api.agentRefresh().catch(() => {})
    }, HANDS_ON_MS)
    return () => clearTimeout(until)
  }, [handsOn, touched])
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
  // The window is opened in the shape of this pane: the pages lay themselves
  // out to its height, so the picture fills what the person gave it. Only the
  // height travels - the width is fixed, or a narrow pane would drop sites to
  // their phone layout and a taught procedure would meet a page it never saw.
  const stage = useRef<HTMLDivElement>(null)
  const frozen = !on && frame
  const paneShown = (on || frozen) && !folded
  useEffect(() => {
    const box = stage.current
    if (!box || !paneShown) return
    let asked = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const tell = () => {
      const rect = box.getBoundingClientRect()
      if (rect.width < 40 || rect.height < 40) return
      // The height the page needs to fill this box at the fixed width, rounded
      // so a drag of a few pixels is not a hundred relayouts.
      const wanted = Math.round((VIEW_WIDTH * rect.height) / rect.width / 20) * 20
      if (wanted === asked) return
      asked = wanted
      void api.agentHeight(wanted).catch(() => {})
    }
    const watch = new ResizeObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(tell, SETTLE_MS)
    })
    watch.observe(box)
    tell()
    return () => {
      if (timer) clearTimeout(timer)
      watch.disconnect()
    }
  }, [paneShown])
  // Nothing live, nothing kept, and nobody asked: no panel. Asked for by
  // hand with nothing open, it stands with its address field - the way a
  // browser opens on a blank tab - and folded it is simply gone; the globe
  // by the composer is where it comes back.
  if (!on && !frozen && !wanted) return null
  if (folded) return null
  const host = hostOf(url)
  return (
    <aside
      className={`web-pane${frozen ? ' frozen' : ''}${closing ? ' closing' : ''}`}
      data-testid="web-pane"
      style={width ? ({ '--web-pane-width': `${width}px` } as CSSProperties) : undefined}
    >
      <div className="web-pane-grip" onMouseDown={drag} aria-hidden />
      <div className="web-pane-inner">
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
          <Address url={url} />
          {!frozen && (
            <>
              <button className="live-dock-act" data-testid="live-refresh" aria-label={t('live.refresh')} title={t('live.refresh')} onClick={() => void api.agentRefresh().catch(() => {})}>
                <RotateCw size={13} aria-hidden />
              </button>
              {/* The page has got somewhere neither the person nor the comet
                  can get back from: close it, and the next ask starts clean. */}
              <button className="live-dock-act" data-testid="live-reset" aria-label={t('live.reset')} title={t('live.reset')} onClick={() => void api.agentReset(channel).catch(() => {})}>
                <X size={13} aria-hidden />
              </button>
            </>
          )}
          {busy && (
            <button className="web-pane-stop" data-testid="web-pane-stop" onClick={onStop}>
              <Square size={10} strokeWidth={2.5} aria-hidden /> {t('bubble.stop')}
            </button>
          )}
        </div>
        {/* The picture keeps the page's own shape: the stage is exactly as
            tall as the frame is wide, so nothing is letterboxed inside a
            field and the space left over is simply the pane. */}
        <div
          className={`web-pane-stage${switching ? ' switching' : ''}`}
          ref={stage}
          onPointerDown={() => setTouched(Date.now())}
          onWheel={() => setTouched(Date.now())}
          onKeyDown={() => setTouched(Date.now())}
        >
          <MirrorSurface live={on} hasFrame={frame} />
        </div>
        <div className="web-pane-note">{frozen ? t('live.closed') : host ? t('live.hint') : t('live.empty')}</div>
        {children}
      </div>
    </aside>
  )
}
