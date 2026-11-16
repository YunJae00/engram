import { expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/api.js', () => ({ api: {} }))
import { answerSites } from '../src/renderer/src/components/SiteIcon.js'
import { routineTask } from '../../../packages/core/src/routine-task.js'

it('ends code-wrapped URLs before adjacent Korean prose', () => {
  const text = '현재 `https://naver.com`을 열었습니다. [Example](https://example.com/path?q=1).'
  // A site linked by name in the text is not a chip as well (see below); the routine still keeps both addresses.
  expect(answerSites(text).map(site => site.url)).toEqual(['https://naver.com/'])
  expect(routineTask(text, []).urls).toEqual(['https://naver.com/', 'https://example.com/path?q=1'])
})

// grokbar c3 L1-L4: "출처: 네이버 날씨" in the text and a search.naver.com chip under it showed the source twice.
it('draws a site chip only for an address the answer does not already link by name', () => {
  const named = '오늘 서울은 흐리고 오후에 비가 와요. [네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)'
  expect(answerSites(named)).toEqual([])
  const bare = '오늘 서울은 흐려요.\n\nhttps://search.naver.com/search.naver?query=서울+날씨'
  expect(answerSites(bare).map(site => site.label)).toEqual(['search.naver.com'])
  expect(answerSites('오늘 서울은 흐려요.')).toEqual([])
  // Another page of a site already linked by name adds no chip; a different site does.
  expect(answerSites(`${named}\nhttps://search.naver.com/other https://www.apple.com/kr/iphone/`).map(site => site.label)).toEqual(['apple.com'])
  // A link whose text is the address itself names nothing.
  expect(answerSites('[https://a.example/x](https://a.example/x)').map(site => site.label)).toEqual(['a.example'])
})
