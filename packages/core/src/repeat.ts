import { contentWords } from './search-template.js'
import { guessSchedule, type Schedule } from './schedule.js'

// The same ask coming back on another day is the strongest sign a task
// should stand on its own. Matched by the words that carry the ask, with the
// asking itself ("좀", "해줘", "please") taken off, so "포털 공지 확인해줘!"
// and "포털 공지 좀 확인해 줘" are one ask.

export interface PastAsk {
  text: string
  at: string
}

export interface RepeatVerdict {
  // How many times it has been asked, this one included.
  count: number
  times: Date[]
  schedule: Schedule
}

export const REPEAT_MIN_PRIOR = 2
export const REPEAT_WINDOW = 60
export const REPEAT_OVERLAP = 0.6
const ASKING_TAIL = /(해\s*주세요|해\s*줄래|해\s*줘|해\s*봐|해\s*라|하자|해요|해|좀|요|please|now|again)$/u

// The verbs of asking carry no subject: "check the deploy notice" and
// "check the parking policy" share "check" and nothing else worth sharing.
const GENERIC = /^(좀|확인|처리|정리|진행|부탁|알려|보여|찾아|please|check|run|do|get|make|show|tell|find|look|the|a|an|to|me|my|it|and|for|of)$/
export function askWords(text: string): string[] {
  return contentWords(text.normalize('NFKC'))
    .map((w) => w.replace(ASKING_TAIL, ''))
    .filter((w) => w.length > 1 && !GENERIC.test(w))
}

export function askKey(text: string): string {
  return askWords(text).join(' ')
}

function stem(word: string): string {
  return /^[a-z]/i.test(word) ? word.slice(0, 5) : word.slice(0, 2)
}

export function sameAsk(a: string, b: string): boolean {
  const ka = askKey(a)
  const kb = askKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  const sa = new Set(askWords(a).map(stem))
  const sb = new Set(askWords(b).map(stem))
  const shared = [...sa].filter((w) => sb.has(w)).length
  return shared / Math.max(sa.size, sb.size) >= REPEAT_OVERLAP
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

// Earlier asks on earlier days - at least two of them - make this one the
// third morning, and a standing task worth offering.
export function repeatedAsk(past: readonly PastAsk[], message: string, now = new Date()): RepeatVerdict | null {
  const today = dayKey(now)
  const earlier = past
    .slice(-REPEAT_WINDOW)
    .filter((p) => sameAsk(p.text, message))
    .map((p) => new Date(p.at))
    .filter((d) => !Number.isNaN(d.getTime()) && dayKey(d) !== today)
  const days = new Set(earlier.map(dayKey))
  if (days.size < REPEAT_MIN_PRIOR) return null
  const times = [...earlier, now]
  return { count: times.length, times, schedule: guessSchedule(times) }
}
