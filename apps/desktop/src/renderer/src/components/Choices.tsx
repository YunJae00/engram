import { ArrowRight, CircleHelp } from 'lucide-react'
import type { Translate } from '../i18n.js'
import { DecisionCard } from './DecisionCard.js'

// The ways forward a comet offered beside its question. One tap sends the
// label as the person's own next message, so the thread reads as a
// conversation and the comet hears it the ordinary way.
export function Choices({ options, t, onPick }: { options: string[]; t: Translate; onPick: (label: string) => void }) {
  if (options.length === 0) return null
  return (
    <div className="bots-choices" data-testid="bots-choices">
      <DecisionCard icon={<CircleHelp size={14} />} label={t('card.choose')} title={t('bots.offerAsked')}>
        {options.map((label, i) => (
          <button key={label} className="secondary bots-choice" data-testid={`bots-choice-${i}`} onClick={() => onPick(label)}>
            <span className="bots-choice-number" aria-hidden>{i + 1}</span><span>{label}</span><ArrowRight size={15} aria-hidden />
          </button>
        ))}
      </DecisionCard>
    </div>
  )
}
