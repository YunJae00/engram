import { t } from '../i18n.js'

// The ways forward a comet offered beside its question. One tap sends the
// label as the person's own next message, so the thread reads as a
// conversation and the comet hears it the ordinary way.
export function Choices({ options, onPick }: { options: string[]; onPick: (label: string) => void }) {
  if (options.length === 0) return null
  return (
    <div className="bots-choices" data-testid="bots-choices">
      <span className="bots-offer-text">{t('bots.offerAsked')}</span>
      {options.map((label, i) => (
        <button key={label} className="secondary bots-choice" data-testid={`bots-choice-${i}`} onClick={() => onPick(label)}>
          {label}
        </button>
      ))}
    </div>
  )
}
