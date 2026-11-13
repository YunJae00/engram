import { memo, useEffect, useRef, useState } from 'react'
import { Answer } from './Answer.js'
import { REVEAL_STEP_MS, nextReveal } from '../lib/streamReveal.js'

export const StreamingAnswer = memo(function StreamingAnswer({ text, done, citations = false }: { text: string; done: boolean; citations?: boolean }) {
  const wrote = useRef(!done)
  if (!done) wrote.current = true
  const [shown, setShown] = useState(() => (wrote.current ? 0 : text.length))
  const at = useRef(shown)
  useEffect(() => {
    if (!wrote.current || done) {
      at.current = text.length
      setShown(text.length)
      return
    }
    if (text.length < at.current) at.current = 0
    if (at.current >= text.length) return
    const timer = setInterval(() => {
      at.current = nextReveal(at.current, text.length, false)
      setShown(at.current)
      if (at.current >= text.length) clearInterval(timer)
    }, REVEAL_STEP_MS)
    return () => clearInterval(timer)
  }, [text, done])
  return <Answer text={text.slice(0, shown)} citations={citations} streaming={!done || shown < text.length} />
})
