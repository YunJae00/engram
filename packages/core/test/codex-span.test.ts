import { describe, expect, it } from 'vitest'
import { parseCodexSpan } from '../src/sessions.js'

// The codex dialect: role+content at top level or one envelope down, text in
// *_text blocks. Torn tails and junk lines never throw.
describe('parseCodexSpan', () => {
  it('reads top-level and payload-wrapped messages', () => {
    const span =
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '헬름 차트로 통일할까?' }], timestamp: 't1' }) +
      '\n' +
      JSON.stringify({ payload: { role: 'assistant', content: [{ type: 'output_text', text: '통일이 맞다. values 정리만 남음.' }] }, timestamp: 't2' }) +
      '\n'
    const { turns } = parseCodexSpan(span)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ role: 'user', text: '헬름 차트로 통일할까?' })
    expect(turns[1]).toMatchObject({ role: 'assistant', text: '통일이 맞다. values 정리만 남음.' })
  })

  it('skips junk, tool records and the torn last line', () => {
    const span =
      '{"type":"session_meta","cwd":"C:/w"}\n' +
      'not json at all\n' +
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }) +
      '\n' +
      '{"type":"message","role":"user","content":[{"ty' // torn
    const { turns, consumed } = parseCodexSpan(span)
    expect(turns).toHaveLength(1)
    expect(consumed).toBeLessThan(Buffer.byteLength(span, 'utf8'))
  })
})
