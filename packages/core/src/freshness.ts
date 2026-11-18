import type { DecayLevel, Note } from './schema.js'

const WINDOW_DAYS: Record<DecayLevel, number | null> = {
  evergreen: null,
  slow: 180,
  fast: 30,
  ephemeral: 7,
}

const IMMINENT_RATIO = 0.2

type Freshness = 'fresh' | 'aging' | 'stale' | 'disputed'

const FRESHNESS_BADGE: Record<Freshness, string> = {
  fresh: '🟢',
  aging: '🟡',
  stale: '🔴',
  disputed: '⚔️',
}

export function verificationWindowDays(decay: DecayLevel): number | null {
  return WINDOW_DAYS[decay]
}

const SALIENCE_WINDOW_FACTOR = 2

export function freshnessOf(note: Note, now: Date = new Date()): Freshness {
  if (note.front.status === 'disputed') return 'disputed'
  const baseWindow = WINDOW_DAYS[note.front.decay]
  if (baseWindow === null) return 'fresh'
  const windowDays = note.front.salience === 'high' ? baseWindow * SALIENCE_WINDOW_FACTOR : baseWindow
  const expiry = note.front.verified_until
    ? Date.parse(note.front.verified_until)
    : Date.parse(note.front.created) + windowDays * 86_400_000
  const remaining = expiry - now.getTime()
  if (remaining <= 0) return 'stale'
  if (remaining <= windowDays * 86_400_000 * IMMINENT_RATIO) return 'aging'
  return 'fresh'
}

export function badgeOf(note: Note, now: Date = new Date()): string {
  return FRESHNESS_BADGE[freshnessOf(note, now)]
}
