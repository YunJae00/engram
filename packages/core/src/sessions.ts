// Reading what the user is actually doing, from the transcripts Claude Code
// already writes.
//
// Until now a memory only existed if the user stopped and said "remember this".
// Everything else — the decision reached at the end of an hour's debugging, the
// reason a approach was abandoned — evaporated when the session closed. The
// transcripts are right there on disk (~/.claude/projects/<project>/<id>.jsonl),
// so Engram can watch them while it runs and keep what is worth keeping.
//
// Two constraints shape every choice here:
//   1. Files are HUGE — one measured at 27MB — and append-only, so we read
//      forward from a remembered offset and never re-read.
//   2. Most of a session is worth nothing. Tool calls, thinking, retries and
//      dead ends are how work happens, not what is learned from it.

// One line of transcript, in the only two shapes that carry meaning.
export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
  at: string
}

// Everything else in the file — queue-operation, attachment, ai-title,
// last-prompt, custom-title, system, mode — is UI bookkeeping.
const CARRIES_MEANING = new Set(['user', 'assistant'])

// Assistant content is an array of blocks; `thinking` is the model reasoning
// with itself and `tool_use`/`tool_result` are mechanics. Only prose survives.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: string } => {
      const b = block as { type?: unknown; text?: unknown }
      return b.type === 'text' && typeof b.text === 'string'
    })
    .map((block) => block.text)
    .join('\n')
    .trim()
}

// Parse a SPAN of transcript — the bytes appended since we last looked. A
// partial final line is normal (the file is being written as we read), so it is
// dropped rather than throwing; the next read starts before it.
export function parseSessionSpan(span: string): { turns: SessionTurn[]; consumed: number } {
  const lines = span.split('\n')
  // The last element is either '' (span ended on a newline) or a half-written
  // line. Either way it is not ours yet.
  const complete = lines.slice(0, -1)
  const consumed = complete.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  const turns: SessionTurn[] = []
  for (const line of complete) {
    if (!line.trim()) continue
    let row: { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string }
    try {
      row = JSON.parse(line)
    } catch {
      continue // a corrupt line must never stop the rest of the span
    }
    if (!row.type || !CARRIES_MEANING.has(row.type) || !row.message) continue
    const role = row.message.role === 'assistant' ? 'assistant' : 'user'
    const text = textOf(row.message.content)
    if (!text) continue
    turns.push({ role, text, at: row.timestamp ?? '' })
  }
  return { turns, consumed }
}

function codexTextOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: unknown; text?: unknown }
      return typeof b.text === 'string' && /text/.test(String(b.type ?? '')) ? b.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function parseCodexSpan(span: string): { turns: SessionTurn[]; consumed: number } {
  const lines = span.split('\n')
  const complete = lines.slice(0, -1)
  const consumed = complete.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  const turns: SessionTurn[] = []
  for (const line of complete) {
    if (!line.trim()) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    // The message may sit at the top level or one envelope down (payload/item).
    const candidates = [row, row['payload'], row['item']].filter(
      (c): c is Record<string, unknown> => !!c && typeof c === 'object',
    )
    for (const node of candidates) {
      const role = node['role']
      if (role !== 'user' && role !== 'assistant') continue
      const text = codexTextOf(node['content'])
      if (!text) continue
      turns.push({ role, text, at: String(row['timestamp'] ?? '') })
      break
    }
  }
  return { turns, consumed }
}

// A span worth asking about: enough exchange to have reached something, and
// bounded so one prompt cannot swallow an afternoon.
export const MIN_TURNS_TO_CONSIDER = 4
const MAX_TURNS_PER_ASK = 40
const MAX_CHARS_PER_TURN = 1_500

// What actually travels to the engine. Truncating each turn keeps a single
// pasted logfile from crowding out the twenty turns of reasoning around it.
export function renderSpan(turns: SessionTurn[]): string {
  return turns
    .slice(-MAX_TURNS_PER_ASK)
    .map((turn) => {
      const body = turn.text.length > MAX_CHARS_PER_TURN ? `${turn.text.slice(0, MAX_CHARS_PER_TURN)}…` : turn.text
      return `[${turn.role}] ${body}`
    })
    .join('\n\n')
}

// The project a transcript belongs to, recovered from Claude Code's directory
// name (it encodes the working directory with separators flattened to '-').
// Used only to tell the engine where the work was happening.
export function projectOfTranscript(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  const segments = last.replace(/^[A-Z]--/, '').split('-').filter(Boolean)
  return segments[segments.length - 1] ?? last
}
