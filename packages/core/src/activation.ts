import { effectiveRecallWeight, effectiveWarmth } from './notes.js'
import type { Note } from './schema.js'

const DECAY_D: Record<string, number> = { evergreen: 0.25, slow: 0.4, fast: 0.5, ephemeral: 0.9 }
const DECAY_BETA: Record<string, number> = { evergreen: 0.3, slow: 0, fast: 0, ephemeral: -0.3 }
// Re-exposure is worth a fraction of a real retrieval (implicit re-encounter
// weight in the ledger literature ≈ 0.3).
const WARMTH_USE_WEIGHT = 0.3
// Sigmoid calibration in DAY units, tuned against anchors rather than fitted:
// fresh ≈ .98 · week-old untouched slow ≈ .68 · a month ≈ .43 · a quarter
// ≈ .25 — while five spaced recalls hold a month-old note near .95.
const TAU = -1.2
const SIGMOID_S = 0.55
const MIN_AGE_DAYS = 1 / 48 // ln(t^-d) explodes at t→0; half an hour is "now"

function ageDays(iso: string, now: Date): number {
  return Math.max(MIN_AGE_DAYS, (now.getTime() - Date.parse(iso)) / 86_400_000)
}

// 0..1: the luminance of this memory. 1 = vivid (in active thought), ~0.4 =
// settled, <0.3 = dim — present, retrievable, just not glowing.
export function noteActivation(note: Note, now: Date = new Date()): number {
  const front = note.front
  const d = DECAY_D[front.decay] ?? 0.4
  const L = ageDays(front.created, now)
  const n = 1 + (front.recall_count ?? 0)
  const t1 = front.last_recalled ? Math.min(ageDays(front.last_recalled, now), L) : L
  // Petrov k=1: newest event exact, the other n-1 uses spread over [t1, L].
  let sum = Math.pow(t1, -d)
  if (n > 1 && L > t1) {
    sum += ((n - 1) * (Math.pow(L, 1 - d) - Math.pow(t1, 1 - d))) / ((1 - d) * (L - t1))
  } else if (n > 1) {
    sum += (n - 1) * Math.pow(t1, -d) // all recalls effectively "just now"
  }
  const warmth = effectiveWarmth(front.warmth, now)
  if (warmth > 0 && front.warmth) {
    sum += WARMTH_USE_WEIGHT * warmth * Math.pow(ageDays(front.warmth.at, now), -d)
  }
  const B = Math.log(sum) + (DECAY_BETA[front.decay] ?? 0)
  return 1 / (1 + Math.exp(-(B - TAU) / SIGMOID_S))
}

const ACTIVATION_BLEND = 0.45

export function activationRerank<T extends { id: string; score: number }>(
  hits: T[],
  noteOf: (id: string) => Note | null | undefined,
  now: Date = new Date(),
): T[] {
  if (hits.length < 2) return hits
  // Ratio normalization, NOT min-max: over a candidate pool min-max stretches
  // a hair's-width relevance gap into the full 0..1 span, which would make
  // relevance unbeatable exactly when it says the least. Dividing by the max
  // keeps proportions — near-ties stay near, real leads stay real.
  const max = Math.max(...hits.map((h) => h.score))
  if (max <= 0) return hits
  return hits
    .map((hit) => {
      const note = noteOf(hit.id)
      return { hit, blended: hit.score / max + ACTIVATION_BLEND * (note ? noteActivation(note, now) : 0.5) }
    })
    .sort((a, b) => b.blended - a.blended || a.hit.id.localeCompare(b.hit.id))
    .map((entry) => entry.hit)
}

const FADING_RS_CEILING = 0.55
// Below this storage a dim note is not "fading", it simply never mattered:
// at least one real recall, one link, or salience is the entry bar.
const FADING_STORAGE_FLOOR = Math.log(2) + 0.05

export function fadingMemories(notes: Note[], now: Date = new Date(), cap = 3): Note[] {
  return notes
    .filter((n) => n.front.status === 'current' && n.front.type !== 'hub')
    .filter((n) => noteActivation(n, now) < FADING_RS_CEILING)
    .map((note) => {
      const uses = 1 + (note.front.recall_count ?? 0)
      const degree = note.front.derived_from.length + Object.keys(note.front.recall_links ?? {}).length
      const storage =
        Math.log(1 + uses) + 0.3 * Math.log(1 + degree) + (note.front.salience === 'high' ? 0.5 : 0)
      return { note, storage }
    })
    .filter((entry) => entry.storage > FADING_STORAGE_FLOOR)
    .sort((a, b) => b.storage - a.storage || a.note.front.id.localeCompare(b.note.front.id))
    .slice(0, cap)
    .map((entry) => entry.note)
}

export interface ActivationHit {
  id: string
  score: number
  // The seed note this activation flowed from (for "reminded via X" lines).
  via: string
}

// Edge strength: every structural link carries a base conductance; Hebbian
// weight (decayed to now) thickens it, capped so no synapse becomes a wire.
const BASE_EDGE = 0.35
const HEBBIAN_STEP = 0.12
const EDGE_CAP = 0.85

// Node multipliers — salient memories and recently-recalled memories come to
// mind more readily, exactly like the freshness luminance on the sky.
const SALIENCE_BOOST = 1.5
const RECENT_RECALL_BOOST = 1.2
const RECENT_RECALL_DAYS = 7

export interface SpreadOptions {
  hops?: number // default 2
  limit?: number // default 6
}

function edgeStrength(from: Note, to: Note, now: Date): number {
  const structural =
    from.front.derived_from.includes(to.front.id) || to.front.derived_from.includes(from.front.id)
  const hebb = Math.max(
    from.front.recall_links?.[to.front.id] ? effectiveRecallWeight(from.front.recall_links[to.front.id]!, now) : 0,
    to.front.recall_links?.[from.front.id] ? effectiveRecallWeight(to.front.recall_links[from.front.id]!, now) : 0,
  )
  if (!structural && hebb <= 0) return 0
  return Math.min(EDGE_CAP, (structural ? BASE_EDGE : 0.15) + hebb * HEBBIAN_STEP)
}

function nodeBoost(note: Note, now: Date): number {
  let boost = 1
  if (note.front.salience === 'high') boost *= SALIENCE_BOOST
  if (
    note.front.last_recalled &&
    now.getTime() - Date.parse(note.front.last_recalled) < RECENT_RECALL_DAYS * 86_400_000
  ) {
    boost *= RECENT_RECALL_BOOST
  }
  // A warm neighbourhood makes a memory come to mind more readily too.
  boost *= 1 + 0.25 * Math.min(1, effectiveWarmth(note.front.warmth, now))
  return boost
}

// Spread from the seeds over the corpus. `seeds` maps note id → ignition
// score (search score, normalized or raw — only relative order matters).
// Returns non-seed notes ranked by peak activation reached.
export function spreadActivation(
  seeds: Map<string, number>,
  corpus: Note[],
  now: Date = new Date(),
  options: SpreadOptions = {},
): ActivationHit[] {
  const hops = options.hops ?? 2
  const limit = options.limit ?? 6
  if (seeds.size === 0 || corpus.length === 0) return []
  const byId = new Map(corpus.map((n) => [n.front.id, n]))
  // Adjacency once: structural links (both directions) + hebbian-only synapses.
  const neighbours = new Map<string, Set<string>>()
  const join = (a: string, b: string) => {
    if (!byId.has(a) || !byId.has(b)) return
    if (!neighbours.has(a)) neighbours.set(a, new Set())
    if (!neighbours.has(b)) neighbours.set(b, new Set())
    neighbours.get(a)!.add(b)
    neighbours.get(b)!.add(a)
  }
  for (const note of corpus) {
    for (const rel of note.front.derived_from) join(note.front.id, rel)
    for (const rel of Object.keys(note.front.recall_links ?? {})) join(note.front.id, rel)
  }
  // Normalize seed scores so the top seed ignites at 1.
  const top = Math.max(...seeds.values())
  if (top <= 0) return []
  const best = new Map<string, { score: number; via: string }>()
  let frontier: { id: string; energy: number; via: string }[] = []
  for (const [id, score] of seeds) {
    if (byId.has(id)) frontier.push({ id, energy: score / top, via: id })
  }
  for (let hop = 0; hop < hops; hop++) {
    const next: typeof frontier = []
    for (const { id, energy, via } of frontier) {
      const from = byId.get(id)!
      for (const relId of neighbours.get(id) ?? []) {
        if (seeds.has(relId)) continue // already lit by the query itself
        const to = byId.get(relId)!
        const strength = edgeStrength(from, to, now)
        if (strength <= 0) continue
        const arrived = energy * strength * nodeBoost(to, now)
        const prior = best.get(relId)
        if (!prior || arrived > prior.score) {
          best.set(relId, { score: arrived, via })
          next.push({ id: relId, energy: arrived, via })
        }
      }
    }
    frontier = next
    if (frontier.length === 0) break
  }
  return [...best.entries()]
    .map(([id, { score, via }]) => ({ id, score, via }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
}

export function triggeredNotes(queryText: string, corpus: Note[]): Note[] {
  const q = queryText.toLowerCase()
  if (!q.trim()) return []
  return corpus.filter((note) =>
    (note.front.triggers ?? []).some((t) => t.trim().length >= 2 && q.includes(t.trim().toLowerCase())),
  )
}
