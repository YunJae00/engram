import { relevantSkillCards, type SkillCard, type SkillsLedger } from 'core'
import { embedLive } from './semantic.js'

const unit = (vector: Float32Array): Float32Array => {
  const length = Math.hypot(...vector) || 1
  return vector.map(value => value / length)
}

export async function meaningScores(text: string, candidates: string[]): Promise<number[] | null> {
  if (!text.trim() || !candidates.length) return null
  const vectors = await embedLive([text, ...candidates])
  if (!vectors || vectors.length !== candidates.length + 1) return null
  const [first, ...rest] = vectors.map(unit)
  return rest.map(vector => vector.reduce((sum, value, index) => sum + value * first![index]!, 0))
}

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
