import { Bookmark, Clock, Play } from 'lucide-react'
import type { CometOffer as Offer } from '../lib/cometThreads.js'
import { scheduleLabel, timesLabel } from '../lib/schedule.js'
import { t } from '../i18n.js'

type Standing = Extract<Offer, { kind: 'standing' }>
type Run = Extract<Offer, { kind: 'run' }>

// What a comet's answer leaves on the table: run the procedure it found,
// keep the ask as a one-press task, make a repeated one stand on its own, or
// be shown a job it was never taught. Read off what happened, never a fixed
// row of buttons; the parent clears the offer the moment one is taken.
export function CometOffer({
  offer,
  onKeep,
  onRun,
  onStand,
  onDecline,
}: {
  offer: Exclude<Offer, { kind: 'asked' }>
  onKeep(name: string, goal: string): void
  onRun(offer: Run): void
  onStand(offer: Standing): void
  onDecline(offer: Standing): void
}) {
  return (
    <div className="bots-offer" data-testid="bots-offer">
      <span className="bots-offer-text">
        {offer.kind === 'run'
          ? t('bots.offerRun', { name: offer.name })
          : offer.kind === 'keep'
            ? t('bots.offerKeep')
            : t('bots.offerStanding', { name: offer.name, times: timesLabel(offer.count), when: scheduleLabel(offer.schedule) })}
      </span>
      {offer.kind === 'standing' ? (
        <>
          <button className="primary bots-offer-run" data-testid="bots-offer-standing-go" onClick={() => onStand(offer)}>
            <Clock size={11} strokeWidth={2.5} aria-hidden /> {t('bots.offerStandingGo', { when: scheduleLabel(offer.schedule) })}
          </button>
          <button className="secondary" data-testid="bots-offer-standing-no" onClick={() => onDecline(offer)}>
            {t('bots.offerStandingNo')}
          </button>
        </>
      ) : offer.kind === 'keep' ? (
        <button className="primary bots-offer-run" data-testid="bots-offer-keep" onClick={() => onKeep(offer.name, offer.goal)}>
          <Bookmark size={11} strokeWidth={2.5} aria-hidden /> {t('bots.offerKeepGo')}
        </button>
      ) : (
        <button className="primary bots-offer-run" data-testid="bots-offer-run" onClick={() => onRun(offer)}>
          <Play size={11} strokeWidth={2.5} aria-hidden /> {t('routines.run')}
        </button>
      )}
    </div>
  )
}
