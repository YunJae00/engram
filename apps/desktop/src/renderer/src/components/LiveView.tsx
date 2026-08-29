import { AppWindow, Maximize2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AgentInputDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useApp } from '../state.js'

// The agent browser, seen from inside the app: a small card of the page it
// is on while it works, and — opened up — a large view the person can act
// in, so a sign-in, a robot check or a lesson happens here rather than in a
// window they would have to go and find.

const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const
const BUTTON: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' }
const MOVE_EVERY_MS = 40
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

function useMirror(): { on: boolean; url?: string; frame: string | null; size: { width: number; height: number } } {
  const [on, setOn] = useState(false)
  const [url, setUrl] = useState<string | undefined>(undefined)
  const [frame, setFrame] = useState<string | null>(null)
  const [size, setSize] = useState({ width: 1440, height: 900 })
  useEffect(() => {
    void api
      .agentWatch(true)
      .then((state) => {
        setOn(state.on)
        setUrl(state.url)
      })
      .catch(() => {})
    const off = api.onEvent((event) => {
      if (event.type === 'agent:live') {
        setOn(event.on)
        setUrl(event.url)
        if (!event.on) setFrame(null)
      } else if (event.type === 'agent:frame') {
        setFrame(`data:image/jpeg;base64,${event.data}`)
        setUrl(event.url)
        setSize({ width: event.width, height: event.height })
      }
    })
    return () => {
      off()
      void api.agentWatch(false).catch(() => {})
    }
  }, [])
  return { on, url, frame, size }
}

function Stage({ frame, size }: { frame: string | null; size: { width: number; height: number } }) {
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
    if (!p) return
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
    send({ kind: 'key', type, key: e.key, code: e.code, keyCode: e.keyCode, ...(typed ? { text: typed } : {}), modifiers: modifiersOf(e) })
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
        if (p) send({ kind: 'mouse', type: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) })
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
          if (e.data) send({ kind: 'text', text: e.data })
          e.currentTarget.value = ''
        }}
        onPaste={(e) => {
          e.preventDefault()
          const text = e.clipboardData.getData('text')
          if (text) send({ kind: 'text', text })
        }}
        onChange={(e) => {
          // Anything that slipped past the key handler is typed as text.
          if (!(e.nativeEvent as InputEvent).isComposing && e.target.value) {
            send({ kind: 'text', text: e.target.value })
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

// open: the large view comes up on its own — a lesson is done there, and a
// wall is cleared there, not watched from a card. children: the controls
// that belong beside the page (a lesson's Done, a wall's Continue), shown
// on the large view too.
export function LiveView({ open = false, children }: { open?: boolean; children?: ReactNode }) {
  const { t } = useApp()
  const { on, url, frame, size } = useMirror()
  const [big, setBig] = useState(false)
  const [windowOut, setWindowOut] = useState(false)
  // The large view opens once there is a page to show, and closes with it.
  useEffect(() => {
    if (on) {
      if (open) setBig(true)
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
  if (!on) return null
  const host = hostOf(url)
  const callWindow = () => {
    const next = !windowOut
    setWindowOut(next)
    void api.agentWindow(next).catch(() => {})
  }
  return (
    <>
      <div className="live-card" data-testid="live-card" role="button" tabIndex={0} title={t('live.expand')} onClick={() => setBig(true)}>
        {frame ? <img src={frame} alt="" draggable={false} /> : <span className="live-waiting">{t('live.waiting')}</span>}
        <span className="live-card-bar">
          <span className="live-card-host">{host || t('live.caption')}</span>
          <Maximize2 size={12} aria-hidden />
        </span>
      </div>
      {big &&
        createPortal(
          <div className="brief-overlay live-overlay" onClick={() => setBig(false)}>
            <div className="live-panel" data-testid="live-panel" onClick={(e) => e.stopPropagation()}>
              <div className="live-panel-bar">
                <Address url={url} />
                <button className="secondary live-panel-window" onClick={callWindow}>
                  <AppWindow size={12} aria-hidden /> {t(windowOut ? 'live.hideWindow' : 'live.openWindow')}
                </button>
                <button className="sheet-close" aria-label={t('live.close')} onClick={() => setBig(false)}>
                  <X size={14} aria-hidden />
                </button>
              </div>
              <Stage frame={frame} size={size} />
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
