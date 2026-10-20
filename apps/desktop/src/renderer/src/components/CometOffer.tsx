import { Bookmark, Check, Clock, Play, X } from 'lucide-react'
import { useState } from 'react'
import type { Translate } from '../i18n.js'
import type { CometOffer as Offer } from '../lib/cometThreads.js'
import { scheduleLabel, timesLabel } from '../lib/schedule.js'
import { DecisionCard } from './DecisionCard.js'

type Standing = Extract<Offer, { kind: 'standing' }>
type Run = Extract<Offer, { kind: 'run' }>
type Keep = Extract<Offer, { kind: 'keep' }>

// A job worth keeping is put the way a colleague would put it: here is what
// I would call it, here is what pressing it would do, shall I? The label is
// the comet's own writing, not the words the person happened to type, and it
// is theirs to change before anything is kept - so the row of buttons that
// builds up over months reads as work rather than as old messages.
function KeepOffer({ offer, t, onKeep, onNo }: { offer: Keep; t: Translate; onKeep(name: string, goal: string): void | Promise<void>; onNo(): void }) {
  const [name, setName] = useState(offer.name)
  const [goal, setGoal] = useState(offer.goal)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async () => {
    if (saving) return
    setSaving(true); setError('')
    try { await onKeep((name || offer.name).trim(), goal.trim()) }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setSaving(false) }
  }
  const title = editing ? (
    <input
      className="comet-keep-name"
      data-testid="bots-offer-keep-name"
      value={name}
      autoFocus
      maxLength={32}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') setEditing(false)
        if (e.key === 'Escape') { setName(offer.name); setEditing(false) }
      }}
      onBlur={() => setEditing(false)}
    />
  ) : (
    <button className="comet-keep-name" data-testid="bots-offer-keep-rename" onClick={() => setEditing(true)} title={t('bots.keepRename')}>{name || offer.name}</button>
  )
  return (
    <div className="comet-keep" data-testid="bots-offer-keep-card">
      <DecisionCard
        tone="info"
        icon={<Bookmark size={14} />}
        label={t('card.offer')}
        title={title}
        sub={offer.does}
        hint={t('bots.keepAsk')}
        actions={<>
          <button className="secondary" data-testid="bots-offer-keep-no" disabled={saving} onClick={onNo}><X size={11} strokeWidth={2.5} aria-hidden /> {t('bots.keepNo')}</button>
          <button className="primary bots-offer-run" data-testid="bots-offer-keep" disabled={saving || !goal.trim()} onClick={() => void save()}><Check size={11} strokeWidth={2.5} aria-hidden /> {t('bots.keepYes')}</button>
        </>}
      >
        <div className="comet-keep-instructions"><label>Instructions for each new run<textarea aria-label="Routine instructions" rows={3} value={goal} maxLength={4000} onChange={event => setGoal(event.target.value)} /></label><small>Only these instructions, starting pages and navigation hints are saved - not this chat or its approvals.</small></div>
        {error && <p role="alert">Could not save this routine: {error}</p>}
      </DecisionCard>
    </div>
  )
}

// What a comet's answer leaves on the table: run the procedure it found,
// keep the ask as a one-press task, make a repeated one stand on its own, or
// be shown a job it was never taught. Read off what happened, never a fixed
// row of buttons; the parent clears the offer the moment one is taken.
export function CometOffer({
  offer,
  t,
  onKeep,
  onRun,
  onStand,
  onDecline,
  onDismiss,
}: {
  offer: Exclude<Offer, { kind: 'asked' }>
  t: Translate
  onKeep(name: string, goal: string): void | Promise<void>
  onRun(offer: Run): void
  onStand(offer: Standing): void
  onDecline(offer: Standing): void
  onDismiss(): void
}) {
  if (offer.kind === 'keep') return <KeepOffer offer={offer} t={t} onKeep={onKeep} onNo={onDismiss} />
  if (offer.kind === 'standing') return (
    <div className="bots-offer" data-testid="bots-offer">
      <DecisionCard
        tone="info"
        icon={<Clock size={14} />}
        label={t('card.offer')}
        title={t('bots.offerStanding', { name: offer.name, times: timesLabel(offer.count, t), when: scheduleLabel(offer.schedule, t) })}
        actions={<>
          <button className="secondary" data-testid="bots-offer-standing-no" onClick={() => onDecline(offer)}>{t('bots.offerStandingNo')}</button>
          <button className="primary bots-offer-run" data-testid="bots-offer-standing-go" onClick={() => onStand(offer)}>{t('bots.offerStandingGo', { when: scheduleLabel(offer.schedule, t) })}</button>
        </>}
      />
    </div>
  )
  return (
    <div className="bots-offer" data-testid="bots-offer">
      <DecisionCard
        tone="info"
        icon={<Play size={14} />}
        label={t('card.offer')}
        title={t('bots.offerRun', { name: offer.name })}
        actions={<button className="primary bots-offer-run" data-testid="bots-offer-run" onClick={() => onRun(offer)}><Play size={11} strokeWidth={2.5} aria-hidden /> {t('routines.run')}</button>}
      />
    </div>
  )
}
