import { describe, expect, it } from 'vitest'
import { answersTheQuestion, deriveSearchTemplate, rankLinks, searchUrlFor } from '../src/search-template.js'

// Naming search engines in code fixes the answer for everyone and can never
// learn a company's own search. The shape is learned from one address the
// person pastes — whichever search that happens to be.
describe('deriveSearchTemplate', () => {
  it('learns the shape from a results address, whatever the site', () => {
    expect(deriveSearchTemplate('https://search.example.co.kr/search?query=ai+동향&where=web')).toBe(
      'https://search.example.co.kr/search?query={q}&where=web',
    )
    expect(deriveSearchTemplate('https://wiki.company.internal/find?text=deploy%20policy')).toBe(
      'https://wiki.company.internal/find?text={q}',
    )
  })

  it('picks the parameter that actually held the words when it is told them', () => {
    const pasted = 'https://s.example.com/r?lang=ko&q=helm&session=abcdefghijklmnop'
    expect(deriveSearchTemplate(pasted, 'helm')).toBe('https://s.example.com/r?lang=ko&q={q}&session=abcdefghijklmnop')
  })

  it('refuses what is not a results address', () => {
    expect(deriveSearchTemplate('https://example.com/')).toBeNull()
    expect(deriveSearchTemplate('not a url')).toBeNull()
    expect(deriveSearchTemplate('file:///c:/secrets?q=x')).toBeNull()
    expect(deriveSearchTemplate('https://example.com/?q=')).toBeNull()
  })
})

describe('searchUrlFor', () => {
  it('fills the blank and escapes the words', () => {
    expect(searchUrlFor('https://s.example.com/r?q={q}', 'ai 동향')).toBe(
      'https://s.example.com/r?q=ai%20%EB%8F%99%ED%96%A5',
    )
  })

  it('refuses a template that lost its blank, rather than searching for nothing', () => {
    expect(searchUrlFor('https://s.example.com/r?q=fixed', 'anything')).toBeNull()
    expect(searchUrlFor('javascript:alert({q})', 'x')).toBeNull()
  })
})

// Measured: the comet followed the first link on a results page and landed on
// the site's own browser promo. What separates a result from furniture is
// whether it echoes the question.
describe('rankLinks', () => {
  const links = [
    { text: '웨일 브라우저 다운로드', url: 'https://whale.example.com/ko/?wpid=theme1' },
    { text: '메일', url: 'https://mail.example.com/' },
    { text: 'AI 동향 2026: 국내 기업들의 전략 분석', url: 'https://news.example.com/a/1' },
    { text: 'AI 관련 기술 블로그', url: 'https://blog.example.com/ai' },
  ]

  it('puts what the question asked about first, and the furniture last', () => {
    const ranked = rankLinks(links, 'ai 동향')
    expect(ranked[0]!.url).toBe('https://news.example.com/a/1')
    expect(ranked.map((one) => one.url)).not.toEqual([links[0]!.url, links[1]!.url, links[2]!.url, links[3]!.url])
  })

  it('keeps the page order when nothing echoes the question, and honours the cap', () => {
    const ranked = rankLinks(links, 'zzz', 2)
    expect(ranked).toHaveLength(2)
    expect(ranked[0]!.text.length).toBeGreaterThanOrEqual(ranked[1]!.text.length)
  })
})

// A question that names nothing lands on a page about something else, and a
// colleague who writes that up has invented the job.
describe('answersTheQuestion', () => {
  it('accepts a page that carries a word the question asked about', () => {
    expect(answersTheQuestion('deployment moves to Thursday afternoon', 'when is the deployment')).toBe(true)
  })

  it('refuses a page that shares nothing with the question', () => {
    expect(answersTheQuestion('deployment moves to Thursday afternoon', 'handle that for me')).toBe(false)
  })

  it('sees past the ending glued on the end of a word', () => {
    // What the person types and what the page says differ at the tail.
    expect(answersTheQuestion('공지사항: VPN 주소가 바뀝니다', '공지에서 VPN 주소 언제 바뀌어?')).toBe(true)
  })

  it('reads a word that carries its ending with it', () => {
    expect(answersTheQuestion('배포는 목요일 오후로 당긴다', '배포 언제야')).toBe(true)
    expect(answersTheQuestion('배포는 목요일 오후로 당긴다', '그거 처리해줘')).toBe(false)
  })

  it('refuses a question with nothing in it to match on', () => {
    expect(answersTheQuestion('anything at all', '?')).toBe(false)
  })
})
