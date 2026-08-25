import { X } from 'lucide-react'
import type { BotSuggestionDto } from '../../../shared/types.js'
import { useApp } from '../state.js'

// The rail's offers, grown from the vault. Each can be taken or turned down;
// a refusal is kept beside the comets so the same offer never comes back.

interface Props {
  suggestions: BotSuggestionDto[]
  onCreate: (name: string, purpose: string) => void
  onDismiss: (name: string) => void
}

export function BotSuggestions({ suggestions, onCreate, onDismiss }: Props) {
  const { t } = useApp()
  if (suggestions.length === 0) return null
  return (
    <div className="bots-suggested" data-testid="bots-suggested">
      <div className="bots-rail-head">{t('bots.suggestedTitle')}</div>
      {suggestions.map((rec) => (
        <div key={rec.name} className="bots-suggestion" data-testid="bots-suggestion">
          <div className="bots-suggestion-head">
            <div className="bots-suggestion-name">{rec.name}</div>
            <button
              className="bots-suggestion-x"
              data-testid="bots-suggestion-dismiss"
              aria-label={t('bots.suggestionDismiss')}
              title={t('bots.suggestionDismiss')}
              onClick={() => onDismiss(rec.name)}
            >
              <X size={11} strokeWidth={2.4} aria-hidden />
            </button>
          </div>
          <div className="bots-suggestion-reason">{rec.reason}</div>
          <button className="secondary" onClick={() => onCreate(rec.name, rec.purpose)}>
            {t('bots.accept')}
          </button>
        </div>
      ))}
    </div>
  )
}
