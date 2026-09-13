import { t } from '../i18n.js'
import { useCometState } from '../state-slices.js'

export function RoutineProgress({ channel }: { channel?: string }) {
  const { routine, routineWall, answerRoutineWall } = useCometState()
  if (!routine.running || routine.channel !== channel) return null
  const wall = routineWall?.channel === channel ? routineWall : null
  return <div className="errand-live" data-testid="routine-live" aria-live="polite">
    <div className="errand-live-goal">{routine.name ?? t('routines.running')}</div>
    {routine.step && <p>{routine.step.label} <span className="errand-step-detail">{routine.step.index + 1}/{routine.step.total}</span></p>}
    {wall && <div className="errand-wall-inline">
      <span>{t(wall.wall === 'login' ? 'routines.wallLogin' : 'routines.wallCaptcha')}</span>
      <button className="errand-wall-done" data-testid="routine-wall-done-live" onClick={() => answerRoutineWall('resolved')}>{t('routines.wallDone')}</button>
      <button className="errand-wall-skip" onClick={() => answerRoutineWall('skip')}>{t('routines.wallStop')}</button>
    </div>}
  </div>
}
