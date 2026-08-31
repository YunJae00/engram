import { AlertTriangle } from 'lucide-react'
import { useApp } from '../state.js'

// A comet at a control that would commit something: it stops and asks. The
// page is on screen right above this, so the question needs no description
// of what is about to happen - the person looks. They can let it go, let it
// go on this site from now on, or take the press themselves in that view.

export function PressGate() {
  const { pressAsk, answerPressAsk, t } = useApp()
  if (!pressAsk) return null
  return (
    <div className="routine-submit" data-testid="press-ask">
      <div className="routine-submit-head">
        <AlertTriangle size={14} aria-hidden /> {t('press.ask', { words: pressAsk.words })}
      </div>
      <div className="routine-submit-hint">{t('press.askHint')}</div>
      <div className="dialog-actions">
        <button className="secondary" data-testid="press-ask-mine" onClick={() => answerPressAsk('cancel')}>
          {t('press.mine')}
        </button>
        {pressAsk.host && (
          <button className="secondary" data-testid="press-ask-always" onClick={() => answerPressAsk('always')}>
            {t('press.always', { host: pressAsk.host })}
          </button>
        )}
        <button className="primary" data-testid="press-ask-go" onClick={() => answerPressAsk('approve')}>
          {t('press.go')}
        </button>
      </div>
    </div>
  )
}
