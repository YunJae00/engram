import { useEffect, useState } from 'react'
import type { FirstSetupDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { Comet } from './Icon.js'

// The wait after setup: one line for where it is, a bar for how far, and the
// time so far by the second. Set aside only once the work could not go on;
// it then goes on in the background.
const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// Why it paused, in words a person can act on.
const pauseText = (reason = ''): string =>
  /outage|not answering|stream|resting/i.test(reason) ? 'The AI is not answering right now'
    : /quota|limit/i.test(reason) ? 'The AI reached its usage limit'
      : /auth|log ?in|sign/i.test(reason) ? 'The AI sign-in needs renewing in Settings'
        : /failed|deferred/i.test(reason) ? 'Some of it could not be organized yet'
          : 'The AI did not answer'

function where(status: FirstSetupDto): { label: string; count?: string; share: number } {
  if (status.phase === 'ai') return { label: 'Connecting to your AI', share: 0.03 }
  if (status.phase === 'map') return { label: 'Finding where you work', share: 0.08 }
  if (status.phase === 'done') return { label: 'Your Cosmos is ready', share: 1 }
  const part = status.total > 0 ? status.done / status.total : 0
  return { label: 'Organizing your Cosmos', ...(status.total > 0 ? { count: `${status.done} / ${status.total}` } : {}), share: 0.1 + 0.9 * part }
}

export function FirstSetup({ status, leaving = false }: { status: FirstSetupDto; leaving?: boolean }) {
  const [now, setNow] = useState(Date.now())
  const [skipping, setSkipping] = useState(false)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const step: ReturnType<typeof where> = skipping && status.phase === 'done' ? { label: 'Finishing in the background', share: 1 } : where(status)
  const paused = status.phase === 'retrying'
  return <div className={`onboarding first-setup-screen${leaving ? ' leaving' : ''}`} data-testid="first-setup">
    <div className="onboard-card first-setup">
      <span className="first-setup-mark" aria-hidden><Comet size={30} /></span>
      <h1>Getting to know your work</h1>
      <p className="first-setup-lead">Only the first time, about 20 minutes</p>
      <div className="first-setup-bar" data-paused={paused || undefined} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(step.share * 100)}>
        <span style={{ width: `${step.share * 100}%` }} />
      </div>
      <div className="first-setup-now">
        <span key={step.label} className="first-setup-step" data-testid="first-setup-step" data-phase={status.phase}>
          {step.label}{step.count && <em>{step.count}</em>}
        </span>
        <time className="first-setup-clock" data-testid="first-setup-clock">{clock(now - status.startedAt)}</time>
      </div>
      {paused && <div className="first-setup-pause" role="status" data-testid="first-setup-retrying">
        <span>{pauseText(status.reason)}. Trying again{status.retryAt ? ` in ${clock(status.retryAt - now)}` : ' shortly'}.</span>
        <button className="secondary" data-testid="first-setup-skip" disabled={skipping} onClick={() => { setSkipping(true); void api.firstSetupSkip().catch(() => setSkipping(false)) }}>Finish in the background</button>
      </div>}
    </div>
  </div>
}
