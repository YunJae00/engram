import { expect, it } from 'vitest'
import { normalizeProse, suggestedReplyDefaults } from '../src/prose.js'

it('repairs escaped paragraphs and list breaks without changing ordinary newlines', () => {
  const broken = String.raw`Today is empty.\n\n1) Draft the items\n2) Tell me your hours\n\nWhich option?`
  expect(normalizeProse(broken)).toBe('Today is empty.\n\n1) Draft the items\n2) Tell me your hours\n\nWhich option?')
  expect(normalizeProse(String.raw`First\r\n\r\nSecond`)).toBe('First\n\nSecond')
  expect(normalizeProse('First\n\nSecond')).toBe('First\n\nSecond')
  expect(normalizeProse(String.raw`Options:\n\n1) Draft`)).toBe('Options:\n\n1) Draft')
  expect(normalizeProse(normalizeProse(broken))).toBe(normalizeProse(broken))
})

it.each([
  String.raw`Use \n in code.`,
  String.raw`C:\new\notes\n\nfile.txt`,
  String.raw`C:\My notes\n\nfile.txt`,
  String.raw`\\server\new\notes`,
  String.raw`{"value":"first\n\nsecond"}`,
  '`' + String.raw`first\n\nsecond` + '`',
  '```js\n' + String.raw`const value = 'first\n\nsecond'` + '\n```',
  '~~~js\n' + String.raw`const value = 'first\n\nsecond'` + '\n~~~',
  '```js\n' + String.raw`const value = 'first\n\nsecond'`,
])('keeps literal escapes in technical content: %s', text => {
  expect(normalizeProse(text)).toBe(text)
})

it('repairs only surrounding prose when code, URLs and paths are mixed into an answer', () => {
  const code = '`' + String.raw`first\n\nsecond` + '`'
  const text = String.raw`Done.\n\nSee https://example.com\n\n${code} and C:\new\notes`
  expect(normalizeProse(text)).toBe(`Done.\n\nSee https://example.com\n\n${code} and C:\\new\\notes`)
})

it('falls back to the thread language for reply defaults when the message has no Hangul', () => {
  const ko = ['좀 더 자세히 알려줘', '핵심만 요약해줘'], en = ['Tell me more', 'Summarize the key points']
  expect(suggestedReplyDefaults('Please sign in or complete the check in the open page.', 'ko')).toEqual(ko)
  expect(suggestedReplyDefaults('Done.', 'en')).toEqual(en)
  expect(suggestedReplyDefaults('Done.')).toEqual(en)
  expect(suggestedReplyDefaults('찾았어요.', 'en')).toEqual(ko)
})
