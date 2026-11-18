import { normalizeProse } from './prose.js'

export interface Ask {
  question: string
  options: string[]
}

const OPTIONS_MIN = 2
const OPTIONS_MAX = 4
const OPTION_CHARS = 40

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
  return `${ASK_HEAD}${JSON.stringify({ question: normalizeProse(question.trim()), options })}`
}

export function parseAsk(observation: string): Ask | null {
  if (!observation.startsWith(ASK_HEAD)) return null
  const body = observation.slice(ASK_HEAD.length)
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as Partial<Ask>
      if (typeof parsed.question === 'string') return parsed.question.trim() ? { question: normalizeProse(parsed.question.trim()), options: cleanOptions(parsed.options) } : null
    } catch { }
  }
  const split = body.lastIndexOf(`\n${OPTIONS_HEAD}`)
  const question = normalizeProse((split < 0 ? body : body.slice(0, split)).trim())
  if (!question) return null
  const line = split < 0 ? undefined : body.slice(split + 1)
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

const ALTERNATIVES = /^(.{1,120}?)\s*(?:,|:)?\s*(?:or|아니면)\s+(.{1,60}?)\?$/i

export function choiceQuestion(text: string): Ask | null {
  const trimmed = text.trim()
  if (!trimmed.endsWith('?')) return null
  const sentences = trimmed.split(/(?<=[.!?])\s+/)
  const last = sentences[sentences.length - 1] ?? ''
  const match = ALTERNATIVES.exec(last)
  if (!match) return null
  const head = match[1]!
  const parts = head.split(/,\s*/)
  const opener = parts[0]!
  const lead = opener.includes(':') ? opener.slice(opener.lastIndexOf(':') + 1).trim() : opener.split(/\s+/).slice(-3).join(' ')
  const options = cleanOptions([lead, ...parts.slice(1), match[2]!])
  if (options.length < OPTIONS_MIN) return null
  return { question: last, options }
}

export function askText(question: string, options: string[] = []): string {
  const said = question.toLowerCase()
  const rest = options.filter(one => !said.includes(one.toLowerCase()))
  return rest.length ? `${question}\n\n${rest.map(one => `- ${one}`).join('\n')}` : question
}
