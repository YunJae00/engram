import { useEffect, useState } from 'react'
import { api } from '../api.js'

// The comet's hand on the mirrored page. Main says where a hand is about to
// land, as fractions of the page; this draws a pointer there, lets it
// travel (the CSS does the moving), rings it on a press, and lets it fade
// once it has been still for a while. Nothing here touches React on every
// frame: a pointer event is rare, one per press or field.

const LINGER_MS = 2_500

export function HandGhost() {
  const [hand, setHand] = useState<{ x: number; y: number; kind: 'move' | 'press'; at: number } | null>(null)
  const [gone, setGone] = useState(true)
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.type !== 'agent:pointer') return
        setHand({ x: event.x, y: event.y, kind: event.kind, at: Date.now() })
        setGone(false)
      }),
    [],
  )
  useEffect(() => {
    if (!hand) return
    const fade = setTimeout(() => setGone(true), LINGER_MS)
    return () => clearTimeout(fade)
  }, [hand])
  if (!hand) return null
  return (
    <div
      className={`hand-ghost${hand.kind === 'press' ? ' press' : ''}${gone ? ' gone' : ''}`}
      style={{ left: `${hand.x * 100}%`, top: `${hand.y * 100}%` }}
      data-testid="hand-ghost"
      aria-hidden
    >
      <span className="hand-ghost-ring" key={hand.at} />
      <svg width="18" height="20" viewBox="0 0 18 20">
        <path d="M2 1.5 L2 15 L5.6 11.8 L8.2 17.6 L10.9 16.4 L8.3 10.7 L13.2 10.5 Z" fill="#fff" stroke="#1d1d1f" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </div>
  )
}
