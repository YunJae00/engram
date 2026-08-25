import { useEffect, useState } from 'react'

// A pending answer given a shape: breathing dots, one line of what the
// evidence says is happening, and the seconds since the question left. A
// slow local answer must never read as a hang. The label may depend on the
// elapsed time, for surfaces whose only evidence is the clock.
// The app's one sign that something is working on the person's behalf.
export function ThinkingDots() {
  return (
    <span className="bubble-dots" aria-hidden>
      <i />
      <i />
      <i />
    </span>
  )
}

export function Thinking({
  label,
  since,
  testId = 'bubble-thinking',
}: {
  label: string | ((seconds: number) => string)
  // When the wait began. Given, the clock survives this component
  // unmounting with its tab; absent, it counts from mount.
  since?: number
  testId?: string
}) {
  const elapsed = () => (since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0)
  const [seconds, setSeconds] = useState(elapsed)
  useEffect(() => {
    const timer = setInterval(() => setSeconds((n) => (since ? elapsed() : n + 1)), 1_000)
    return () => clearInterval(timer)
  }, [since])
  const text = typeof label === 'function' ? label(seconds) : label
  return (
    <span className="bubble-thinking" data-testid={testId}>
      <ThinkingDots />
      {/* Keyed on the words alone: a new sentence breathes in, a count ticking
          up inside the same sentence does not restart the motion. */}
      <span className="bubble-thinking-label" key={text.replace(/\d+/g, '')}>
        {text}
      </span>
      {' '}· {seconds}s
    </span>
  )
}
