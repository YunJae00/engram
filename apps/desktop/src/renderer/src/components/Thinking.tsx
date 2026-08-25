import { useEffect, useState } from 'react'

// A pending answer given a shape: breathing dots, one line of what the
// evidence says is happening, and the seconds since the question left. A
// slow local answer must never read as a hang. The label may depend on the
// elapsed time, for surfaces whose only evidence is the clock.
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
  return (
    <span className="bubble-thinking" data-testid={testId}>
      <span className="bubble-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {typeof label === 'function' ? label(seconds) : label} · {seconds}s
    </span>
  )
}
