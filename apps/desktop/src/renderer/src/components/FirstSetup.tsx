import { Check, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FirstSetupDto } from '../../../shared/types.js'
import { api } from '../api.js'

// The wait after setup, said as the steps it is made of: the AI answering,
// where the person works, and Cosmos being organized from it. Set aside only
// once the work could not go on; it then goes on in the background.
const STEPS = [
  { phase: 'ai', label: 'Connecting to your AI' },
  { phase: 'map', label: 'Finding where you work - the sites, files and apps you allowed' },
  { phase: 'filing', label: 'Organizing it into Cosmos' },
] as const

const ORDER = ['ai', 'map', 'filing', 'done'] as const
const minutes = (ms: number): string => `${Math.max(0, Math.floor(ms / 60_000))} min`
// Why it paused, in words a person can act on.
const pauseText = (reason = ''): string =>
  /outage|not answering|stream|resting/i.test(reason) ? 'the AI is not answering on its side right now'
    : /quota|limit/i.test(reason) ? 'the AI reached its usage limit'
      : /auth|log ?in|sign/i.test(reason) ? 'the AI sign-in needs renewing in Settings'
        : /failed|deferred/i.test(reason) ? 'some of it could not be organized yet'
          : 'the AI did not answer'

export function FirstSetup({ status }: { status: FirstSetupDto }) {
  const [now, setNow] = useState(Date.now())
  const [skipping, setSkipping] = useState(false)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  const reached = ORDER.indexOf(status.phase === 'retrying' ? 'filing' : status.phase)
  return <div className="onboarding" data-testid="first-setup"><div className="onboard-card first-setup">
    <div className="onboard-progress"><strong>Engram</strong><span>{minutes(now - status.startedAt)} so far</span></div>
    <h1>Getting to know your work</h1>
    <p className="first-setup-lead">Engram is reading what you allowed and organizing it into Cosmos, so your first conversation already knows your work. The first time takes about 20 minutes; keep Engram open.</p>
    <ol className="first-setup-steps">
      {STEPS.map((step, index) => {
        const done = index < reached, active = index === reached
        return <li key={step.phase} data-state={done ? 'done' : active ? 'active' : 'waiting'} data-testid={`first-setup-${step.phase}`}>
          {done ? <Check size={15} aria-hidden /> : active ? <LoaderCircle size={15} className="computer-spinner" aria-hidden /> : <span className="first-setup-dot" aria-hidden />}
          <span>{step.label}{active && step.phase === 'filing' && status.total > 0 ? ` - ${status.done} of ${status.total}` : ''}</span>
        </li>
      })}
    </ol>
    {status.phase === 'retrying' && <div className="onboard-fail" role="status" data-testid="first-setup-retrying">
      <span>It paused: {pauseText(status.reason)}. Engram tries again{status.retryAt ? ` in ${minutes(status.retryAt - now + 59_999)}` : ' shortly'}.</span>
      <button className="secondary" data-testid="first-setup-skip" disabled={skipping} onClick={() => { setSkipping(true); void api.firstSetupSkip().catch(() => setSkipping(false)) }}>Finish in the background</button>
    </div>}
  </div></div>
}
