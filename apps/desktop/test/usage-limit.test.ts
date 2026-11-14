import { expect, it } from 'vitest'
import { claudeRetryAfterMs, threadKorean, usageLimitMessage } from '../src/main/usage-limit.js'

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

it('reads the reset time from Claude\'s own limit text, and nothing when it gives none', () => {
  const now = new Date(2026, 10, 14, 13, 0).getTime()
  expect(claudeRetryAfterMs(`Claude AI usage limit reached|${Math.floor(now / 1000) + 7200}`, now)).toBe(7_200_000)
  expect(claudeRetryAfterMs('5-hour limit reached ∙ resets 3pm', now)).toBe(7_200_000)
  expect(claudeRetryAfterMs('limit reached, resets 9:30am', now)).toBe(20.5 * 3_600_000)
  expect(claudeRetryAfterMs('rate limited, retry after 120', now)).toBe(120_000)
  expect(claudeRetryAfterMs('usage limit reached', now)).toBeUndefined()
})

it('keeps the thread language when the latest reply has no letters', () => {
  expect(threadKorean('2', [{ text: '보고서 만들어 줘' }])).toBe(true)
  expect(threadKorean('2', [{ text: 'make the report' }])).toBe(false)
  expect(threadKorean('ok', [{ text: '보고서 만들어 줘' }])).toBe(false)
  expect(threadKorean('응', [])).toBe(true)
})
