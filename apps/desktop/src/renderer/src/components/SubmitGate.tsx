import { Send } from 'lucide-react'
import { cometOfChannel } from '../lib/cometThreads.js'
import { useThreadT } from '../lib/useThreadT.js'
import { useCometState } from '../state-slices.js'
import { DecisionCard } from './DecisionCard.js'

// The last thing between a procedure and a post. It shows the actual words
// that will go into the page, because "approve?" without them is not consent.
export function SubmitGate({ channel }: { channel?: string }) {
  const { routineSubmit, answerRoutineSubmit } = useCometState()
  const t = useThreadT(channel ? cometOfChannel(channel) : null)
  if (!routineSubmit || routineSubmit.channel !== channel) return null
  return (
    <DecisionCard
      testId="routine-submit"
      icon={<Send size={14} />}
      label={t('card.post')}
      title={routineSubmit.name}
      sub={routineSubmit.host ?? undefined}
      actions={<>
        <button className="secondary" data-testid="routine-submit-cancel" onClick={() => answerRoutineSubmit('cancel')}>{t('routines.submitCancel')}</button>
        <button className="primary" data-testid="routine-submit-approve" onClick={() => answerRoutineSubmit('approve')}>{t('routines.submitApprove')}</button>
      </>}
    >
      <ul className="routine-submit-fields">
        {routineSubmit.filled.map((field, i) => (
          <li key={`${i}-${field.label}`}>
            <span className="routine-submit-label">{field.label}</span>
            <span className="routine-submit-value">{field.text}</span>
          </li>
        ))}
      </ul>
      {routineSubmit.canRemember && routineSubmit.host && (
        <button className="decision-card-link" data-testid="routine-submit-always" onClick={() => answerRoutineSubmit('always')}>{t('routines.submitAlways', { host: routineSubmit.host })}</button>
      )}
    </DecisionCard>
  )
}
