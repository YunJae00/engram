import { t } from '../i18n.js'
import { ArrowRight, CircleHelp } from 'lucide-react'

// The ways forward a comet offered beside its question. One tap sends the
// label as the person's own next message, so the thread reads as a
// conversation and the comet hears it the ordinary way.
export function Choices({ options, onPick }: { options: string[]; onPick: (label: string) => void }) {
  if (options.length === 0) return null
  return (
    <section className="bots-choices" data-testid="bots-choices" aria-label="Your answer">
      <div className="bots-question-heading"><CircleHelp size={16} aria-hidden /><span>Your answer</span></div>
      <span className="bots-offer-text">{t('bots.offerAsked')}</span>
      {options.map((label, i) => (
        <button key={label} className="secondary bots-choice" data-testid={`bots-choice-${i}`} onClick={() => onPick(label)}>
          <span className="bots-choice-number" aria-hidden>{i + 1}</span><span>{label}</span><ArrowRight size={15} aria-hidden />
        </button>
      ))}
    </section>
  )
}
