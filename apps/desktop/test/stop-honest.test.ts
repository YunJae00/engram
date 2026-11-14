import { describe, expect, it } from 'vitest'
import { cometChannel, createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { threadT } from '../src/renderer/src/lib/threadLang.js'
import { withRetry } from '../src/renderer/src/lib/stopMark.js'
import { sidebarPreview } from '../src/renderer/src/lib/sidebarPreview.js'
import { VOICE_RULE } from '../../../packages/core/src/agent-voice.js'

const BOT = 'bot-stop-1'
const channel = cometChannel(BOT)

const streaming = (ask: string, partial: string) => {
  const store = createCometThreads(BOT)
  store.begin(BOT, ask)
  if (partial) store.handleEvent({ type: 'chat:token', channel, text: partial })
  return store
}

describe('stopping an answer', () => {
  it('keeps a cut answer and adds the thread-language stopped line', () => {
    expect(threadT('ko')('bubble.stopped')).toBe('중지했어요.')
    expect(threadT('en')('bubble.stopped')).toBe('Stopped.')
    const store = streaming('정리해줘', '회의 안건을 정리했어요')
    expect(store.stop(BOT, 'x', threadT('ko')('bubble.stopped'))).toBe('중지했어요.')
    const messages = store.thread(BOT).messages
    expect(messages.map(m => m.text)).toEqual(['정리해줘', '회의 안건을 정리했어요', '중지했어요.'])
    expect(messages[1]).toMatchObject({ progress: true, streaming: false })
    expect(messages[2]).toMatchObject({ role: 'assistant', work: [] })
    expect(messages.some(m => m.streaming)).toBe(false)
  })

  it('shows the stopped text in an empty bubble', () => {
    const store = streaming('Tidy', '')
    expect(store.stop(BOT, 'Stopped.', 'Stopped.')).toBe('Stopped.')
    expect(store.thread(BOT).messages.map(m => m.text)).toEqual(['Tidy', 'Stopped.'])
  })

  it('offers carrying on first under a stopped or unfinished answer', () => {
    expect(withRetry('중지했어요.', 'ko', ['a', 'b'])).toEqual(['이어서 해줘', 'a', 'b'])
    expect(withRetry('한 일: 없음\n답을 마치지 못하고 끝났어요.\n다음: …', 'ko', ['a'])[0]).toBe('이어서 해줘')
    expect(withRetry('Stopped.', 'en', ['Continue', 'b', 'c', 'd'])).toEqual(['Continue', 'b', 'c'])
    expect(withRetry('Stopped here. Done so far: read', 'en', [])).toEqual(['Continue'])
    expect(withRetry('회의 안건을 정리했어요', 'ko', ['a'])).toEqual(['a'])
  })
})

describe('sidebar preview', () => {
  it('turns a markdown table answer into one plain line', () => {
    const text = '정리했어요.\n\n---\n## 안건\n| 번호 | 안건 |\n|---|---|\n| 1 | 예산 |\n- 메모 **굵게** [링크](https://x.y)'
    for (const input of [text, text.replace(/\s+/g, ' ')]) {
      const preview = sidebarPreview(input)
      expect(preview).not.toMatch(/[|#*]|---/)
      expect(preview).toContain('번호 안건')
      expect(preview).toContain('링크')
    }
    expect(sidebarPreview(text)).not.toMatch(/ - /)
  })
})

describe('voice', () => {
  it('drafts self-contained asks without a notes lookup', () => {
    expect(VOICE_RULE).toMatch(/self-contained/)
    expect(VOICE_RULE).toMatch(/never announce such a search/)
    expect(VOICE_RULE).toContain('지난번')
  })
})
