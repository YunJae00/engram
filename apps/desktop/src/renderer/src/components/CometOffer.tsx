import { Check, Clock, Play, X } from 'lucide-react'
import { useState } from 'react'
import type { CometOffer as Offer } from '../lib/cometThreads.js'
import { scheduleLabel, timesLabel } from '../lib/schedule.js'
import { t } from '../i18n.js'

type Standing = Extract<Offer, { kind: 'standing' }>
type Run = Extract<Offer, { kind: 'run' }>
type Keep = Extract<Offer, { kind: 'keep' }>

// A job worth keeping is put the way a colleague would put it: here is what
// I would call it, here is what pressing it would do, shall I? The label is
// the comet's own writing, not the words the person happened to type, and it
// is theirs to change before anything is kept - so the row of buttons that
// builds up over months reads as work rather than as old messages.
function KeepOffer({ offer, onKeep, onNo }: { offer: Keep; onKeep(name: string, goal: string): void; onNo(): void }) {
  const [name, setName] = useState(offer.name)
  const [editing, setEditing] = useState(false)
  return (
    <div className="comet-keep" data-testid="bots-offer-keep-card">
      <p className="comet-keep-say">{t('bots.keepAsk')}</p>
      <div className="comet-keep-card">
        {editing ? (
          <input
            className="comet-keep-name"
            data-testid="bots-offer-keep-name"
            value={name}
            autoFocus
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setEditing(false)
              if (e.key === 'Escape') {
                setName(offer.name)
                setEditing(false)
              }
            }}
            onBlur={() => setEditing(false)}
          />
        ) : (
          <button className="comet-keep-name" data-testid="bots-offer-keep-rename" onClick={() => setEditing(true)} title={t('bots.keepRename')}>
            {name || offer.name}
          </button>
        )}
        <span className="comet-keep-does">{offer.does}</span>
      </div>
      <div className="comet-keep-acts">
        <button className="primary bots-offer-run" data-testid="bots-offer-keep" onClick={() => onKeep((name || offer.name).trim(), offer.goal)}>
          <Check size={11} strokeWidth={2.5} aria-hidden /> {t('bots.keepYes')}
        </button>
        <button className="secondary" data-testid="bots-offer-keep-no" onClick={onNo}>
          <X size={11} strokeWidth={2.5} aria-hidden /> {t('bots.keepNo')}
        </button>
      </div>
    </div>
  )
}

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
  onDismiss,
}: {
  offer: Exclude<Offer, { kind: 'asked' }>
  onKeep(name: string, goal: string): void
  onRun(offer: Run): void
  onStand(offer: Standing): void
  onDecline(offer: Standing): void
  onDismiss(): void
}) {
  if (offer.kind === 'keep') return <KeepOffer offer={offer} onKeep={onKeep} onNo={onDismiss} />
  return (
    <div className="bots-offer" data-testid="bots-offer">
      <span className="bots-offer-text">
        {offer.kind === 'run'
          ? t('bots.offerRun', { name: offer.name })
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
      ) : (
        <button className="primary bots-offer-run" data-testid="bots-offer-run" onClick={() => onRun(offer)}>
          <Play size={11} strokeWidth={2.5} aria-hidden /> {t('routines.run')}
        </button>
      )}
    </div>
  )
}
