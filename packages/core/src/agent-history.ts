import type { AgentLoopOptions } from './agent-loop.js'
import { contextExcerpt } from './context-excerpt.js'

// The latest turns always travel; earlier ones join, newest first, while
// there is room, so what was found before - an address, a value, an answer -
// is still in front of a fresh session. The person's words keep more room
// than the comet's own.
const HISTORY_TURNS = 4
const HISTORY_ROOM = 32_000
const HISTORY_CHARS = 8_000
const HISTORY_REQUEST_CHARS = 6000

// Requests older than the recent window still carry the rules of work that
// continues days later; the first request and the latest ones fit first.
const EARLIER_REQUESTS_CHARS = 12000
// Suggested replies are the comet's guesses, not the person's words; sent back
// they would let an invented value pass as already in the conversation.
const REPLIES_OPEN = /^[ \t]*```[ \t]*replies[ \t]*$/im
export function withoutReplies(text: string): string {
  const open = text.search(REPLIES_OPEN)
  if (open < 0) return text
  const rest = text.slice(open).split('\n')
  const close = rest.findIndex((line, index) => index > 0 && /^\s*```\s*$/.test(line))
  return (text.slice(0, open) + (close < 0 ? '' : rest.slice(close + 1).join('\n'))).trimEnd()
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

export function conversation(history: AgentLoopOptions['history']): string[] {
  const turns = recentTurns(history ?? [])
  if (turns.length === 0) return []
  return [
    ...earlierRequests(history ?? [], turns.length),
    '',
    'The conversation so far (context for what is being asked; the person\'s earlier requirements still hold when this continues the same work):',
    turns.join('\n'),
  ]
}
