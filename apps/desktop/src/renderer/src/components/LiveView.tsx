import { AppWindow, ChevronDown, Maximize2, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentInputDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { useApp } from '../state.js'

// The agent browser, seen from inside the app: while a comet works, the page
// sits at the foot of the thread, as wide as the conversation and stuck
// there while it scrolls above. Opened up, it becomes a large view the
// person can act in, so a sign-in, a robot check or a question about a press
// happens here rather than in a window they would have to go and find.

const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const
const BUTTON: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' }
const MOVE_EVERY_MS = 40
// What the dock may take of the window's height, and where it starts.
const DOCK_MIN = 160
const DOCK_MAX_SHARE = 0.62
const DOCK_DEFAULT = 340
const DOCK_KEY = 'engram.live.height'
const FOLD_KEY = 'engram.live.folded'
// Keys that mean something to a page beyond a character.
const PRESSED_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? MODIFIER.alt : 0) | (e.ctrlKey ? MODIFIER.ctrl : 0) | (e.metaKey ? MODIFIER.meta : 0) | (e.shiftKey ? MODIFIER.shift : 0)
}

function hostOf(url: string | undefined): string {
  if (!url || url === 'about:blank') return ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function Stage({ frame, size, live }: { frame: string | null; size: { width: number; height: number }; live: boolean }) {
  const { t } = useApp()
  const image = useRef<HTMLImageElement>(null)
  const keys = useRef<HTMLTextAreaElement>(null)
  const lastMove = useRef(0)
  const send = (input: AgentInputDto) => void api.agentInput(input).catch(() => {})
  const at = (e: React.MouseEvent): { x: number; y: number } | null => {
    const rect = image.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return null
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
  }
  const mouse = (e: React.MouseEvent, type: 'pressed' | 'released' | 'moved') => {
    const p = at(e)
    if (!p || !live) return
    if (type === 'moved') {
      const now = Date.now()
      if (now - lastMove.current < MOVE_EVERY_MS) return
      lastMove.current = now
    }
    send({ kind: 'mouse', type, ...p, button: type === 'moved' ? 'none' : (BUTTON[e.button] ?? 'left'), clicks: e.detail, modifiers: modifiersOf(e) })
  }
  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>, type: 'down' | 'up') => {
    // Text being composed (an input method building a character) is left to
    // finish; it arrives whole below.
    if (e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Escape') return
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey
    const typed = type === 'down' && plain && e.key.length === 1 ? e.key : type === 'down' && e.key === 'Enter' ? '\r' : undefined
    if (!typed && !PRESSED_KEYS.has(e.key) && plain && e.key.length !== 1) return
    e.preventDefault()
    if (live) send({ kind: 'key', type, key: e.key, code: e.code, keyCode: e.keyCode, ...(typed ? { text: typed } : {}), modifiers: modifiersOf(e) })
  }
  return (
    <div
      className="live-stage"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
      onMouseDown={(e) => {
        e.preventDefault()
        keys.current?.focus()
        mouse(e, 'pressed')
      }}
      onMouseUp={(e) => mouse(e, 'released')}
      onMouseMove={(e) => mouse(e, 'moved')}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        const p = at(e)
        if (p && live) send({ kind: 'mouse', type: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) })
      }}
    >
      {frame ? <img ref={image} src={frame} alt="" draggable={false} /> : <span className="live-waiting">{t('live.waiting')}</span>}
      <textarea
        ref={keys}
        className="live-keys"
        aria-label={t('live.hint')}
        autoFocus
        onKeyDown={(e) => key(e, 'down')}
        onKeyUp={(e) => key(e, 'up')}
        onCompositionEnd={(e) => {
          if (e.data && live) send({ kind: 'text', text: e.data })
          e.currentTarget.value = ''
        }}
        onPaste={(e) => {
          e.preventDefault()
          const text = e.clipboardData.getData('text')
          if (text && live) send({ kind: 'text', text })
        }}
        onChange={(e) => {
          // Anything that slipped past the key handler is typed as text.
          if (!(e.nativeEvent as InputEvent).isComposing && e.target.value) {
            if (live) send({ kind: 'text', text: e.target.value })
            e.target.value = ''
          }
        }}
      />
    </div>
  )
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

// open: something is being asked about the page, so the dock unfolds to
// show it - the question is answered here, and the large view stays a thing
// the person opens when they want a proper look. keep: hold the dock while
// the turn runs, even between windows, so it does not blink in and out.
// children: what belongs beside the page (the question, a wall's Continue).
export function LiveView({ open = false, keep = false, children }: { open?: boolean; keep?: boolean; children?: ReactNode }) {
  const { t } = useApp()
  const { on, url, frame, width, height } = useSyncExternalStore(agentMirror.subscribe, agentMirror.getSnapshot)
  const size = { width, height }
  const [big, setBig] = useState(false)
  const [windowOut, setWindowOut] = useState(false)
  // Folded to a line by default: the page is there to glance at, and what
  // is asked about it is asked here in words. Unfolds by itself when there
  // is something to look at, and stays wherever the person leaves it.
  const [folded, setFolded] = useState(() => localStorage.getItem(FOLD_KEY) !== '0')
  const [dock, setDock] = useState(() => Number(localStorage.getItem(DOCK_KEY)) || DOCK_DEFAULT)
  // A question about the page unfolds the dock; the window going closes
  // whatever was open on it.
  useEffect(() => {
    if (on) {
      if (open) setFolded(false)
    } else {
      setBig(false)
      setWindowOut(false)
    }
  }, [on, open])
  // Escape closes the large view and nothing behind it: the sheet under it
  // listens for the same key, so the press is used up here first.
  useEffect(() => {
    if (!big) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setBig(false)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [big])
  // The dock's height is dragged from its top edge, and kept for next time.
  const drag = (down: React.MouseEvent) => {
    down.preventDefault()
    const from = down.clientY
    const started = dock
    const move = (e: MouseEvent) => setDock(Math.max(DOCK_MIN, Math.min(window.innerHeight * DOCK_MAX_SHARE, started + (from - e.clientY))))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setDock((held) => {
        localStorage.setItem(DOCK_KEY, String(held))
        return held
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // The page stays after the window has gone: the last thing it showed is
  // what the person reads the answer against.
  const frozen = !on && frame !== null
  if (!on && !(keep && frozen)) return null
  const host = hostOf(url)
  const callWindow = () => {
    const next = !windowOut
    setWindowOut(next)
    void api.agentWindow(next).catch(() => {})
  }
  return (
    <>
      <div className={`live-dock${frozen ? ' frozen' : ''}${folded ? ' folded' : ''}`} data-testid="live-card" style={folded ? undefined : { height: dock }}>
        {!folded && <div className="live-dock-grip" onMouseDown={drag} aria-hidden />}
        <div className="live-dock-bar">
          <button
            className="live-dock-fold"
            data-testid="live-fold"
            aria-label={t(folded ? 'live.unfold' : 'live.fold')}
            title={t(folded ? 'live.unfold' : 'live.fold')}
            onClick={() => {
              localStorage.setItem(FOLD_KEY, folded ? '0' : '1')
              setFolded(!folded)
            }}
          >
            <ChevronDown size={12} className={folded ? 'live-dock-chevron up' : 'live-dock-chevron'} aria-hidden />
          </button>
          <span className="live-card-host">{frozen ? t('live.closed') : host || t('live.caption')}</span>
          {!frozen && (
            <button
              className="live-dock-act"
              data-testid="live-refresh"
              aria-label={t('live.refresh')}
              title={t('live.refresh')}
              onClick={() => void api.agentRefresh().catch(() => {})}
            >
              <RotateCw size={12} aria-hidden />
            </button>
          )}
          <button className="live-dock-act" data-testid="live-expand" aria-label={t('live.expand')} title={t('live.expand')} onClick={() => setBig(true)}>
            <Maximize2 size={12} aria-hidden />
          </button>
        </div>
        {!folded && (
          <div className="live-dock-body">{frame ? <img src={frame} alt="" draggable={false} /> : <span className="live-waiting">{t('live.waiting')}</span>}</div>
        )}
        {/* The controls live in one place at a time: in the large view when
            it is open, in the dock when it is not. */}
        {!big && children}
      </div>
      {big &&
        createPortal(
          <div className="brief-overlay live-overlay" onClick={() => setBig(false)}>
            <div
              className="live-panel"
              data-testid="live-panel"
              style={{ '--live-aspect': `${size.width / size.height}` } as React.CSSProperties}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="live-panel-bar">
                <Address url={url} />
                <button className="secondary live-panel-window" onClick={() => void api.agentRefresh().catch(() => {})}>
                  <RotateCw size={12} aria-hidden /> {t('live.refresh')}
                </button>
                <button className="secondary live-panel-window" onClick={callWindow}>
                  <AppWindow size={12} aria-hidden /> {t(windowOut ? 'live.hideWindow' : 'live.openWindow')}
                </button>
                <button className="sheet-close" aria-label={t('live.close')} onClick={() => setBig(false)}>
                  <X size={14} aria-hidden />
                </button>
              </div>
              <Stage frame={frame} size={size} live={on} />
              <div className="live-panel-foot">
                <span className="live-panel-hint">{t('live.hint')}</span>
                {children}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
