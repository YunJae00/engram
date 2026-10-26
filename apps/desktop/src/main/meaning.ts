import { relevantSkillCards, type SkillCard, type SkillsLedger } from 'core'
import { embedLive } from './semantic.js'

// Matching by meaning, for asks put in other words or another language than
// the work they resemble. It uses the embedder only while it is already up,
// so a turn never waits for the model to load; word matching stays the floor.

const unit = (vector: Float32Array): Float32Array => {
  const length = Math.hypot(...vector) || 1
  return vector.map(value => value / length)
}

// How close in meaning each candidate is to the text, from -1 to 1; null when the embedder is not up.
export async function meaningScores(text: string, candidates: string[]): Promise<number[] | null> {
  if (!text.trim() || !candidates.length) return null
  const vectors = await embedLive([text, ...candidates])
  if (!vectors || vectors.length !== candidates.length + 1) return null
  const [first, ...rest] = vectors.map(unit)
  return rest.map(vector => vector.reduce((sum, value, index) => sum + value * first![index]!, 0))
}

// A how-to close in meaning is a hint worth offering even when no word matches.
const SKILL_MEANING = 0.6
const SHORTLIST = 5

export async function skillShortlist(cards: SkillCard[], ledger: SkillsLedger, task: string): Promise<SkillCard[]> {
  const byWords = relevantSkillCards(cards, ledger, task)
  const rest = cards.filter(card => !byWords.includes(card))
  if (byWords.length >= SHORTLIST || !rest.length) return byWords
  const scores = await meaningScores(task, rest.map(card => `${card.name.replace(/^engram-/, '')}: ${card.description}`))
  if (!scores) return byWords
  const near = rest.map((card, index) => ({ card, score: scores[index]! })).filter(one => one.score >= SKILL_MEANING).sort((a, b) => b.score - a.score)
  return [...byWords, ...near.map(one => one.card)].slice(0, SHORTLIST)
}
