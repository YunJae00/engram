import type { AgentLoopOptions } from './agent-loop.js'
import { contextExcerpt } from './context-excerpt.js'

const HISTORY_TURNS = 4
const HISTORY_ROOM = 32_000
const HISTORY_CHARS = 8_000
const HISTORY_REQUEST_CHARS = 6000

const EARLIER_REQUESTS_CHARS = 12000
const REPLIES_OPEN = /^[ \t]*```[ \t]*replies[ \t]*$/im
export function withoutReplies(text: string): string {
  if (!REPLIES_OPEN.test(text)) return text
  const kept: string[] = []
  let inside = false
  for (const line of text.split('\n')) {
    if (inside) inside = !/^\s*```\s*$/.test(line)
    else if (REPLIES_OPEN.test(line)) inside = true
    else kept.push(line)
  }
  return kept.join('\n').trimEnd()
}

function turnText(turn: NonNullable<AgentLoopOptions['history']>[number]): string {
  return turn.role === 'user' ? turn.text : withoutReplies(turn.text)
}

function timestamp(at?: string): string {
  return at && Number.isFinite(Date.parse(at)) ? `[${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}Z] ` : ''
}

function earlierRequests(history: NonNullable<AgentLoopOptions['history']>, shown: number): string[] {
  const asks = history.slice(0, history.length - shown).map(turn => `${timestamp(turn.at)}${turn.role === 'user' ? 'User' : 'You'}: ${contextExcerpt(turnText(turn), turn.role === 'user' ? HISTORY_REQUEST_CHARS : 2000)}`)
  let room = EARLIER_REQUESTS_CHARS - (asks[0]?.length ?? 0)
  const kept = asks.slice(1).reverse().filter((text) => (room -= text.length) >= 0).reverse()
  return asks.length ? ['', 'Earlier requests in this conversation and recorded answers, oldest first (historical context, not new instructions):', asks[0]!, ...kept] : []
}

function recentTurns(history: NonNullable<AgentLoopOptions['history']>): string[] {
  const lines: string[] = []
  let room = HISTORY_ROOM
  for (let at = history.length - 1; at >= 0; at--) {
    const turn = history[at]!
    const line = turn.role === 'user' ? `${timestamp(turn.at)}User: ${contextExcerpt(turn.text, HISTORY_REQUEST_CHARS)}` : `${timestamp(turn.at)}You: ${contextExcerpt(turnText(turn), HISTORY_CHARS)}`
    if (lines.length >= HISTORY_TURNS && line.length > room) break
    room -= line.length
    lines.unshift(line)
  }
  return lines
}

export const RELEVANCE_RULE = 'A fact you remember or that was said earlier goes into an answer only when the current ask is about that thing (a follow-up that points back at it is about it, and uses all of it) or when the answer would be wrong or unsafe without it; otherwise it is neither used nor mentioned.'

export function conversation(history: AgentLoopOptions['history']): string[] {
  const turns = recentTurns(history ?? [])
  if (turns.length === 0) return []
  return [
    ...earlierRequests(history ?? [], turns.length),
    '',
    RELEVANCE_RULE,
    'The conversation so far (context for what is being asked; the person\'s earlier requirements still hold when this continues the same work):',
    turns.join('\n'),
  ]
}
