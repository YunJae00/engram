import { useEffect, useRef } from 'react'
import type { AgentInputDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { FrameScreen } from './FrameScreen.js'
import { HandGhost } from './HandGhost.js'
import { t } from '../i18n.js'

// The mirrored page as a surface a person can act on: every click, wheel and
// key on the picture is played into the agent window as their own. One
// component, used wherever the mirror is shown large enough to work in.
//
// Coordinates are measured against the CANVAS, not its container: the picture
// keeps its own shape inside whatever box the layout gives it, and a click in
// the letterbox must not land on the page as a click near its edge.

const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const
const BUTTON: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' }
const MOVE_EVERY_MS = 40
// Keys that mean something to a page beyond a character.
const PRESSED_KEYS = new Set(['Enter', 'Backspace', 'Delete', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? MODIFIER.alt : 0) | (e.ctrlKey ? MODIFIER.ctrl : 0) | (e.metaKey ? MODIFIER.meta : 0) | (e.shiftKey ? MODIFIER.shift : 0)
}

export function MirrorSurface({ live, hasFrame }: { live: boolean; hasFrame: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const keys = useRef<HTMLTextAreaElement>(null)
  const lastMove = useRef(0)
  const send = (input: AgentInputDto) => void api.agentInput(input).catch(() => {})
  // The canvas box fills its stage and the picture sits inside it at its
  // own shape (object-fit: contain), so the two differ by a band above and
  // below or either side whenever the shapes do not match. A point is read
  // against the picture, or it lands on the page a band's width off.
  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const canvas = box.current?.querySelector('canvas')
    const rect = canvas?.getBoundingClientRect()
    if (!canvas || !rect || rect.width === 0 || rect.height === 0 || canvas.width === 0 || canvas.height === 0) return null
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
    const drawnW = canvas.width * scale
    const drawnH = canvas.height * scale
    const left = rect.left + (rect.width - drawnW) / 2
    const top = rect.top + (rect.height - drawnH) / 2
    const x = (e.clientX - left) / drawnW
    const y = (e.clientY - top) / drawnH
    if (x < 0 || x > 1 || y < 0 || y > 1) return null
    return { x, y }
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
  // The wheel must reach the page and nothing behind it, which takes a
  // listener the browser is not allowed to treat as passive.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = at(e)
      if (p && live) send({ kind: 'mouse', type: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [live])
  return (
    <div
      ref={box}
      className="mirror-surface"
      onMouseDown={(e) => {
        e.preventDefault()
        keys.current?.focus()
        mouse(e, 'pressed')
      }}
      onMouseUp={(e) => mouse(e, 'released')}
      onMouseMove={(e) => mouse(e, 'moved')}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="mirror-screen" hidden={!hasFrame}>
        <FrameScreen />
        <HandGhost />
      </div>
      {!hasFrame && <span className="live-waiting mirror-waiting">{t('live.waiting')}</span>}
      <textarea
        ref={keys}
        className="live-keys"
        aria-label={t('live.hint')}
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
