// A question put to the person, with the ways forward beside it. Small
// models write "do you want A or B?" as prose and the person types an answer
// back; offered as choices to tap, the same question is settled in one touch
// and the answer lands in the thread as their own words.

export interface Ask {
  question: string
  options: string[]
}

export const OPTIONS_MIN = 2
export const OPTIONS_MAX = 4
export const OPTION_CHARS = 40

// A choice that hands the work back is not a way forward. Offered "cancel"
// beside "the deploy note", a person who delegated the job so as not to think
// about it is being asked to think about it again.
const NOT_FORWARD =
  /^(cancel|never ?mind|forget it|skip( it)?|stop|no|not|none|nothing|do it (myself|yourself)|i('ll| will) do it( myself)?|later|취소|그만|됐어요?|나중에|직접 할게요?|아니요?|없음|몰라요?)[.!]?$/i

export function cleanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const kept: string[] = []
  for (const one of raw) {
    if (typeof one !== 'string') continue
    const label = one.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
    if (!label || label.length > OPTION_CHARS || NOT_FORWARD.test(label)) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(label)
    if (kept.length === OPTIONS_MAX) break
  }
  return kept.length >= OPTIONS_MIN ? kept : []
}

const ASK_HEAD = 'ASK: '
const OPTIONS_HEAD = 'OPTIONS: '

export function formatAsk(question: string, options: string[]): string {
  const head = `${ASK_HEAD}${question.trim()}`
  return options.length ? `${head}\n${OPTIONS_HEAD}${JSON.stringify(options)}` : head
}

export function parseAsk(observation: string): Ask | null {
  if (!observation.startsWith(ASK_HEAD)) return null
  const [first = '', ...rest] = observation.split('\n')
  const question = first.slice(ASK_HEAD.length).trim()
  if (!question) return null
  const line = rest.find((l) => l.startsWith(OPTIONS_HEAD))
  let options: string[] = []
  if (line) {
    try {
      options = cleanOptions(JSON.parse(line.slice(OPTIONS_HEAD.length)))
    } catch {
      options = []
    }
  }
  return { question, options }
}

// A prose answer that is really a question with two to four alternatives in
// it: "the staging one or the production one?" / "A, B, or C?" / "A 아니면 B?".
// Only the last sentence counts, only when every alternative is short, and
// anything that does not fit that shape exactly stays prose - a wrong chip
// is worse than no chip.
const ALTERNATIVES = /^(.{1,120}?)\s*(?:,|:)?\s*(?:or|아니면)\s+(.{1,60}?)\?$/i

export function choiceQuestion(text: string): Ask | null {
  const trimmed = text.trim()
  if (!trimmed.endsWith('?')) return null
  const sentences = trimmed.split(/(?<=[.!?])\s+/)
  const last = sentences[sentences.length - 1] ?? ''
  const match = ALTERNATIVES.exec(last)
  if (!match) return null
  const head = match[1]!
  // "X, A, B" - the alternatives are the trailing comma list; "would you
  // like A" - the alternative is what follows the last verb-ish word, which
  // no rule can find, so only the comma-separated and the "A or B" shapes are
  // accepted.
  const parts = head.split(/,\s*/)
  const opener = parts[0]!
  const lead = opener.includes(':') ? opener.slice(opener.lastIndexOf(':') + 1).trim() : opener.split(/\s+/).slice(-3).join(' ')
  const options = cleanOptions([lead, ...parts.slice(1), match[2]!])
  if (options.length < OPTIONS_MIN) return null
  return { question: last, options }
}
