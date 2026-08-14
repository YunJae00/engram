import { describe, expect, it } from 'vitest'
import { parseSessionSpan, projectOfTranscript, renderSpan } from '../src/sessions.js'

// Claude Code transcripts are append-only JSONL, measured at 27MB for a single
// session, and most lines are UI bookkeeping. Engram reads forward from a
// remembered offset while the app runs, so the parser has to survive being
// handed a span that ends mid-line.

const line = (o: unknown) => JSON.stringify(o) + '\n'
const user = (text: string, at = '2026-07-29T00:00:00Z') =>
  line({ type: 'user', timestamp: at, message: { role: 'user', content: text } })
const assistant = (blocks: unknown[], at = '2026-07-29T00:01:00Z') =>
  line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: blocks } })

describe('reading a transcript span', () => {
  it('keeps the conversation and drops the bookkeeping', () => {
    const span =
      line({ type: 'queue-operation', operation: 'enqueue', content: 'ignored' }) +
      user('왜 이게 안 되지?') +
      line({ type: 'ai-title', title: 'ignored' }) +
      assistant([{ type: 'text', text: '토큰이 만료돼서임.' }]) +
      line({ type: 'mode', mode: 'ignored' })
    const { turns } = parseSessionSpan(span)
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns[0]!.text).toBe('왜 이게 안 되지?')
    expect(turns[1]!.text).toBe('토큰이 만료돼서임.')
  })

  it('drops the model thinking to itself and its tool mechanics', () => {
    const span = assistant([
      { type: 'thinking', thinking: 'let me check the branch' },
      { type: 'tool_use', name: 'Bash', input: { command: 'git log' } },
      { type: 'text', text: '결론만 남는다' },
    ])
    const { turns } = parseSessionSpan(span)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.text).toBe('결론만 남는다')
  })

  it('skips a turn that carried no prose at all', () => {
    const { turns } = parseSessionSpan(assistant([{ type: 'tool_use', name: 'Read', input: {} }]))
    expect(turns).toEqual([])
  })

  // The file is being appended to while we read it.
  it('leaves a half-written final line for the next read', () => {
    const whole = user('첫 줄')
    const span = whole + '{"type":"user","message":{"role":"user","content":"잘린'
    const { turns, consumed } = parseSessionSpan(span)
    expect(turns).toHaveLength(1)
    expect(consumed).toBe(Buffer.byteLength(whole, 'utf8'))
  })

  it('reports consumed bytes in BYTES, not characters', () => {
    const span = user('한글은 세 바이트다')
    const { consumed } = parseSessionSpan(span)
    expect(consumed).toBe(Buffer.byteLength(span, 'utf8'))
    expect(consumed).toBeGreaterThan(span.length)
  })

  it('survives a corrupt line without losing the rest', () => {
    const { turns } = parseSessionSpan('{not json\n' + user('살아남음'))
    expect(turns).toHaveLength(1)
  })
})

describe('what travels to the engine', () => {
  it('truncates a pasted wall of text so it cannot crowd out the reasoning', () => {
    const rendered = renderSpan([{ role: 'user', text: 'x'.repeat(5_000), at: '' }])
    expect(rendered.length).toBeLessThan(1_700)
    expect(rendered).toContain('…')
  })

  it('keeps the most RECENT turns when a span is long', () => {
    const turns = Array.from({ length: 60 }, (_, i) => ({ role: 'user' as const, text: `turn ${i}`, at: '' }))
    const rendered = renderSpan(turns)
    expect(rendered).toContain('turn 59')
    expect(rendered).not.toContain('turn 0\n')
  })
})

describe('naming the project a transcript belongs to', () => {
  it('recovers the working directory leaf from the flattened folder name', () => {
    expect(projectOfTranscript('C--Users-ykwon060-Desktop-pjt-chatx')).toBe('chatx')
    expect(projectOfTranscript('/home/me/.claude/projects/C--Users-me-Desktop-pjt-strata-strata')).toBe('strata')
  })
})
