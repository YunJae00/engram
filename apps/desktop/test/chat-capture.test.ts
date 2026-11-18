import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { captureReceipt, extractChatCaptures } from '../src/main/ipc.js'

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

describe('what the answer says about a thing it was asked to keep', () => {
  it('says nothing in a Korean thread when it was kept, and one plain Korean line when it was not', () => {
    expect(captureReceipt(0, 0, null, true)).toBe('')
    expect(captureReceipt(1, 1, null, true)).toBe('')
    expect(captureReceipt(3, 3, null, true)).toBe('')
    const failed = captureReceipt(1, 0, new Error('EACCES: permission denied, open /Users/x/inbox/a.md'), true)
    expect(failed).toBe('\n\n이건 적어 두지 못했어요. 한 번만 다시 말씀해 주세요.')
    expect(captureReceipt(3, 1, new Error('ENOSPC'), true)).toBe('\n\n3개 중 2개는 적어 두지 못했어요. 한 번만 다시 말씀해 주세요.')
    for (const line of [failed, captureReceipt(3, 1, new Error('ENOSPC'), true)]) expect(line).not.toMatch(/[A-Za-z]|기억|메모리|저장/)
  })

  it('keeps the receipt an English thread already had, and the handler asks by the thread\'s language', async () => {
    expect(captureReceipt(1, 1, null, false)).toBe('\n\n✓ Remembered — the librarian is filing it')
    expect(captureReceipt(2, 1, null, false)).toContain('Could not save 1 of 2 items')
    expect(await readFile('apps/desktop/src/main/ipc.ts', 'utf8')).toContain('captureReceipt(captures.length, saved, saveError, threadKorean(request.message, request.history ?? []))')
  })
})
