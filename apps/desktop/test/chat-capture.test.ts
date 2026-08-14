import { describe, expect, it } from 'vitest'
import { extractChatCaptures } from '../src/main/ipc.js'

describe('extractChatCaptures', () => {
  it('lifts the marked item out and leaves clean prose', () => {
    const { text, captures } = extractChatCaptures(
      '추가했어 — 내일 아침에 보일 거야.\n\n<engram:capture>Samil News — test@example.com으로 메일 계속 발송됨, 확인 필요 (08-06)</engram:capture>',
    )
    expect(captures).toEqual(['Samil News — test@example.com으로 메일 계속 발송됨, 확인 필요 (08-06)'])
    expect(text).toBe('추가했어 — 내일 아침에 보일 거야.')
  })

  it('handles several items, skips empty blocks, touches nothing else', () => {
    const { text, captures } = extractChatCaptures(
      'both noted\n<engram:capture>item one</engram:capture>\n<engram:capture>  </engram:capture>\n<engram:capture>item two</engram:capture>',
    )
    expect(captures).toEqual(['item one', 'item two'])
    expect(text).toBe('both noted')
  })

  it('an ordinary answer passes through untouched', () => {
    const { text, captures } = extractChatCaptures('그건 어제 이미 해결했어.')
    expect(captures).toEqual([])
    expect(text).toBe('그건 어제 이미 해결했어.')
  })
})
