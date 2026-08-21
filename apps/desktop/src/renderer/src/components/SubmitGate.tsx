import { AlertTriangle } from 'lucide-react'
import { useApp } from '../state.js'

// The last thing between a procedure and a post. It shows the actual words
// that will go into the page, because "approve?" without them is not consent.
export function SubmitGate() {
  const { routineSubmit, answerRoutineSubmit, t } = useApp()
  if (!routineSubmit) return null
  return (
    <div className="routine-submit" data-testid="routine-submit">
      <div className="routine-submit-head">
        <AlertTriangle size={14} aria-hidden /> {t('routines.submitAsk', { name: routineSubmit.name })}
      </div>
      <ul className="routine-submit-fields">
        {routineSubmit.filled.map((field, i) => (
          <li key={`${i}-${field.label}`}>
            <span className="routine-submit-label">{field.label}</span>
            <span className="routine-submit-value">{field.text}</span>
          </li>
        ))}
      </ul>
      <div className="dialog-actions">
        <button className="secondary" data-testid="routine-submit-cancel" onClick={() => answerRoutineSubmit('cancel')}>
          {t('routines.submitCancel')}
        </button>
        <button className="primary" data-testid="routine-submit-approve" onClick={() => answerRoutineSubmit('approve')}>
          {t('routines.submitApprove')}
        </button>
      </div>
    </div>
  )
}
