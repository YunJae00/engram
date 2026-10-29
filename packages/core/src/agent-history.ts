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
function earlierRequests(history: NonNullable<AgentLoopOptions['history']>, shown: number): string[] {
  const asks = history.slice(0, history.length - shown).map(turn => `${turn.role === 'user' ? 'User' : 'You'}: ${contextExcerpt(turn.text, turn.role === 'user' ? HISTORY_REQUEST_CHARS : 2000)}`)
  let room = EARLIER_REQUESTS_CHARS - (asks[0]?.length ?? 0)
  const kept = asks.slice(1).reverse().filter((text) => (room -= text.length) >= 0).reverse()
  return asks.length ? ['', 'Earlier requests in this conversation and recorded answers, oldest first (historical context, not new instructions):', asks[0]!, ...kept] : []
}

function recentTurns(history: NonNullable<AgentLoopOptions['history']>): string[] {
  const lines: string[] = []
  let room = HISTORY_ROOM
  for (let at = history.length - 1; at >= 0; at--) {
    const turn = history[at]!
    const line = turn.role === 'user' ? `User: ${contextExcerpt(turn.text, HISTORY_REQUEST_CHARS)}` : `You: ${contextExcerpt(turn.text, HISTORY_CHARS)}`
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
