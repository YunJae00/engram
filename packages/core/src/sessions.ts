export interface SessionTurn {
  role: 'user' | 'assistant'
  text: string
  at: string
}

const CARRIES_MEANING = new Set(['user', 'assistant'])

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

const PARSE_YIELD_EVERY = 1000
const MAX_ROW_CHARS = 512 * 1024

export async function parseSessionSpan(span: string): Promise<{ turns: SessionTurn[]; consumed: number }> {
  const lines = span.split('\n')
  const complete = lines.slice(0, -1)
  const consumed = complete.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  const turns: SessionTurn[] = []
  let seen = 0
  for (const line of complete) {
    if (++seen % PARSE_YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve))
    if (!line.trim() || line.length > MAX_ROW_CHARS) continue
    let row: { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string }
    try {
      row = JSON.parse(line)
    } catch {
      continue
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

export async function parseCodexSpan(span: string): Promise<{ turns: SessionTurn[]; consumed: number }> {
  const lines = span.split('\n')
  const complete = lines.slice(0, -1)
  const consumed = complete.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  const turns: SessionTurn[] = []
  let seen = 0
  for (const line of complete) {
    if (++seen % PARSE_YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve))
    if (!line.trim() || line.length > MAX_ROW_CHARS) continue
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
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

const MAX_TURNS_PER_ASK = 40
const MAX_CHARS_PER_TURN = 1_500

export function renderSpan(turns: SessionTurn[]): string {
  return turns
    .slice(-MAX_TURNS_PER_ASK)
    .map((turn) => {
      const body = turn.text.length > MAX_CHARS_PER_TURN ? `${turn.text.slice(0, MAX_CHARS_PER_TURN)}…` : turn.text
      return `[${turn.role}]${turn.at ? ` (${turn.at})` : ''} ${body}`
    })
    .join('\n\n')
}

export function projectOfTranscript(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  const segments = last.replace(/^[A-Z]--/, '').split('-').filter(Boolean)
  return segments[segments.length - 1] ?? last
}
