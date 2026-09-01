import { useEffect, useRef, useState } from 'react'
import { Answer } from './Answer.js'

// An answer as it is written. What arrives is not a smooth stream: while the
// work is being done nothing comes at all, and then the reply lands in a few
// lumps within a moment of each other (measured: one turn's reply arrived as
// four pieces, the last of them together with the end of the turn). Dropped
// in whole, that reads as a thump rather than as writing. So what has
// arrived is let out at a steady pace, and finishing the turn only makes the
// pace brisk - never a jump to the end. An answer that was already complete
// when it first appeared - anything read back from disk - is simply there.

// How much of what is waiting goes out each step: a share of the remainder,
// so a large lump drains in a few steps and a trickle keeps up exactly. When
// the turn is over the share is bigger, so the tail is brisk without ever
// being instant.
const SHARE = 6
const SHARE_SETTLING = 3
const LEAST = 2
const LEAST_SETTLING = 8
const STEP_MS = 32

export function StreamingAnswer({ text, done }: { text: string; done: boolean }) {
  // A message that has never been mid-answer in this view is history: it is
  // shown whole, with no pacing at all.
  const wrote = useRef(!done)
  if (!done) wrote.current = true
  const [shown, setShown] = useState(() => (wrote.current ? 0 : text.length))
  const at = useRef(shown)
  useEffect(() => {
    if (!wrote.current) {
      at.current = text.length
      setShown(text.length)
      return
    }
    // A reply that starts over after a tool call is shorter than what was
    // already shown; it begins again rather than rewinding word by word.
    if (text.length < at.current) at.current = 0
    if (at.current >= text.length) return
    const share = done ? SHARE_SETTLING : SHARE
    const least = done ? LEAST_SETTLING : LEAST
    const timer = setInterval(() => {
      at.current = Math.min(text.length, at.current + Math.max(least, Math.ceil((text.length - at.current) / share)))
      setShown(at.current)
      if (at.current >= text.length) clearInterval(timer)
    }, STEP_MS)
    return () => clearInterval(timer)
  }, [text, done])
  return <Answer text={text.slice(0, shown)} />
}
