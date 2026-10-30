import { memo, useEffect, useRef, useState } from 'react'
import { Answer } from './Answer.js'


const SHARE = 6
const SHARE_SETTLING = 3
const LEAST = 2
const LEAST_SETTLING = 8
const STEP_MS = 80

export const StreamingAnswer = memo(function StreamingAnswer({ text, done, citations = false }: { text: string; done: boolean; citations?: boolean }) {
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
  return <Answer text={text.slice(0, shown)} citations={citations} streaming={!done || shown < text.length} />
})
