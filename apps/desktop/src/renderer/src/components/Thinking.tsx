import { useEffect, useState } from 'react'

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
  total = (seconds: number) => `Total ${seconds}s`,
}: {
  label: string | ((seconds: number) => string)
  since?: number
  testId?: string
  total?: (seconds: number) => string
}) {
  const elapsed = () => (since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0)
  const [seconds, setSeconds] = useState(elapsed)
  useEffect(() => {
    const timer = setInterval(() => setSeconds((n) => (since ? elapsed() : n + 1)), 1_000)
    return () => clearInterval(timer)
  }, [since])
  const text = typeof label === 'function' ? label(seconds) : label
  return (
    <span className="bubble-thinking" data-testid={testId} role="status" aria-label={text}>
      <ThinkingDots />
      <span className="bubble-thinking-label" key={text.replace(/\d+/g, '')}>
        {text}
      </span>
      <span className="thinking-elapsed" aria-hidden>{total(seconds)}</span>
    </span>
  )
}
