import { describe, expect, it } from 'vitest'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads'

describe('closing after a provider error', () => {
  it('shows the closing even when the error already settled the bubble', () => {
    const threads = createCometThreads(null)
    threads.begin('bot-1', '정리해줘')
    threads.handleEvent({ type: 'chat:error', channel: 'bot-bot-1', message: 'Provider unavailable' })
    threads.carryOn('bot-1')
    threads.handleEvent({ type: 'chat:done', channel: 'bot-bot-1', text: '답을 마치지 못하고 끝났어요.\n다음: 이어서 해줘' })
    expect(threads.thread('bot-1').messages.some(m => m.text.includes('다음:'))).toBe(true)
  })
})
