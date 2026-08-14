import { titleTokens } from './topicSubject.js'

const LABEL_MAX_TOKENS = 2
const FALLBACK_MAX = 24
const HUB_LABEL_MAX = 28

export function shortTopicLabel(title: string): string {
  const head = title.split(/[:：]|\s[—–-]\s/)[0]!.trim() || title.trim()
  if (head.length <= HUB_LABEL_MAX) return head
  return `${head.slice(0, HUB_LABEL_MAX - 1).trimEnd()}…`
}

// Lead title cut down to a label: the ticket prefix (noise even alone) goes,
// then ~24 chars with an ellipsis.
function truncatedLead(leadTitle: string): string {
  const lead = leadTitle.replace(/^\[?[A-Z]+-\d+\]?\s*/, '').trim() || leadTitle.trim()
  if (lead.length <= FALLBACK_MAX) return lead
  return `${lead.slice(0, FALLBACK_MAX - 1).trimEnd()}…`
}

export function deriveTopicLabel(leadTitle: string, memberTitles: string[]): string {
  const tokenLists = memberTitles.map(titleTokens)

  // Document frequency, case-folded for counting; display keeps the first
  // original spelling seen.
  const df = new Map<string, number>()
  const display = new Map<string, string>()
  for (const tokens of tokenLists) {
    for (const token of new Set(tokens.map((t) => t.toLowerCase()))) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
    for (const token of tokens) {
      const key = token.toLowerCase()
      if (!display.has(key)) display.set(key, token)
    }
  }
  const freq = (token: string): number => df.get(token.toLowerCase()) ?? 0

  let best: { tokens: string[]; score: number } | null = null
  for (const tokens of tokenLists) {
    for (let i = 0; i < tokens.length; i++) {
      if (freq(tokens[i]!) < 2) continue
      const run = [tokens[i]!]
      let score = freq(tokens[i]!)
      for (let j = i + 1; j < tokens.length && run.length < LABEL_MAX_TOKENS; j++) {
        if (freq(tokens[j]!) < 2) break
        run.push(tokens[j]!)
        score += freq(tokens[j]!)
      }
      const better =
        !best ||
        run.length > best.tokens.length ||
        (run.length === best.tokens.length && score > best.score)
      if (better) best = { tokens: run, score }
    }
  }

  if (!best) return truncatedLead(leadTitle)
  return best.tokens.map((t) => display.get(t.toLowerCase()) ?? t).join(' ')
}
