import { LogIn, ShieldCheck, Workflow } from 'lucide-react'
import { cometOfChannel } from '../lib/cometThreads.js'
import { useThreadT } from '../lib/useThreadT.js'
import { useCometState } from '../state-slices.js'
import { DecisionCard } from './DecisionCard.js'

// A saved routine at work: which one and where it is, and - when a page
// wants a person - what to do there and the two ways on.
export function RoutineProgress({ channel }: { channel?: string }) {
  const { routine, routineWall, answerRoutineWall } = useCometState()
  const t = useThreadT(channel ? cometOfChannel(channel) : null)
  if (!routine.running || routine.channel !== channel) return null
  const wall = routineWall?.channel === channel ? routineWall : null
  const step = routine.step ? `${routine.step.label} · ${routine.step.index + 1}/${routine.step.total}` : undefined
  if (!wall) return (
    <div data-testid="routine-live" aria-live="polite">
      <DecisionCard role="status" tone="info" icon={<Workflow size={14} />} label={t('card.routine')} title={routine.name ?? t('routines.running')} sub={step} />
    </div>
  )
  return (
    <div data-testid="routine-live" aria-live="polite">
      <DecisionCard
        icon={wall.wall === 'login' ? <LogIn size={14} /> : <ShieldCheck size={14} />}
        label={t(wall.wall === 'login' ? 'card.signIn' : 'card.check')}
        title={t(wall.wall === 'login' ? 'routines.wallLogin' : 'routines.wallCaptcha')}
        sub={[routine.name, step].filter(Boolean).join(' · ')}
        actions={<>
          <button className="secondary errand-wall-skip" onClick={() => answerRoutineWall('skip')}>{t('routines.wallStop')}</button>
          <button className="primary errand-wall-done" data-testid="routine-wall-done-live" onClick={() => answerRoutineWall('resolved')}>{t('routines.wallDone')}</button>
        </>}
      />
    </div>
  )
}
