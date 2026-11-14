import { expect, it } from 'vitest'
import { usageLimitMessage } from '../src/main/usage-limit.js'

it('says in the thread language when Claude can pick the work up again', () => {
  const now = new Date(2026, 10, 14, 13, 0).getTime()
  const three = new Date(2026, 10, 14, 15, 0).getTime()
  expect(usageLimitMessage(true, three, now)).toBe('AI 사용 한도에 도달했어요. 오후 3시쯤 다시 이어서 할 수 있어요.')
  expect(usageLimitMessage(false, three, now)).toBe('AI usage limit reached. I can pick this up again around 3 PM.')
  expect(usageLimitMessage(true, new Date(2026, 10, 14, 9, 30).getTime() + 86_400_000, now)).toContain('오전 9시 30분쯤')
  expect(usageLimitMessage(true, undefined, now)).toContain('잠시 후에')
  expect(usageLimitMessage(false, now - 1, now)).toContain('in a while')
  expect(usageLimitMessage(false, undefined, now)).not.toMatch(/ChatGPT|Codex/)
})
