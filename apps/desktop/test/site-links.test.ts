import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
import { answerSites } from '../src/renderer/src/components/SiteIcon.js'
import { routineTask } from '../../../packages/core/src/routine-task.js'

it('ends code-wrapped URLs before adjacent Korean prose', () => {
  const text = '현재 `https://naver.com`을 열었습니다. [Example](https://example.com/path?q=1).'
  expect(answerSites(text).map(site => site.url)).toEqual(['https://naver.com/'])
  expect(routineTask(text, []).urls).toEqual(['https://naver.com/', 'https://example.com/path?q=1'])
})

it('draws a site chip only for an address the answer does not already link by name', () => {
  const named = '오늘 서울은 흐리고 오후에 비가 와요. [네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)'
  expect(answerSites(named)).toEqual([])
  const bare = '오늘 서울은 흐려요.\n\nhttps://search.naver.com/search.naver?query=서울+날씨'
  expect(answerSites(bare).map(site => site.label)).toEqual(['search.naver.com'])
  expect(answerSites('오늘 서울은 흐려요.')).toEqual([])
  expect(answerSites(`${named}\nhttps://search.naver.com/other https://www.apple.com/kr/iphone/`).map(site => site.label)).toEqual(['apple.com'])
  expect(answerSites('[https://a.example/x](https://a.example/x)').map(site => site.label)).toEqual(['a.example'])
})
