import { describe, expect, it } from 'vitest'
import { answersTheQuestion, asksForNote, deriveSearchTemplate, namesSubject, noteTitleFor, rankLinks, searchUrlFor } from '../src/search-template.js'

// "Handle that" names nothing to handle. Looked up, it lands on whatever is
// nearest; the only move that supplies the subject is asking for it.
describe('noteTitleFor', () => {
  it('takes the asking off the request', () => {
    expect(noteTitleFor('이사 준비랑 집안일 합쳐서 할 일 목록 노트로 만들어줘')).toBe('이사 준비랑 집안일 합쳐서 할 일 목록')
    expect(noteTitleFor('write down the VPN change date')).toBe('the VPN change date')
    expect(noteTitleFor('write down the status of the release')).toBe('the status of the release')
    expect(noteTitleFor('다음 스프린트 방향을 노트로 정리해서 저장해줘')).toBe('다음 스프린트 방향')
  })
})

describe('asksForNote', () => {
  it('hears a request to write something down', () => {
    expect(asksForNote('이사 준비랑 집안일 합쳐서 할 일 목록 노트로 만들어줘')).toBe(true)
    expect(asksForNote('write that down for me')).toBe(true)
  })
  it('does not hear one in a question that merely mentions notes', () => {
    expect(asksForNote('지난번 색인 장애 원인이 뭔지 알려줘')).toBe(false)
    expect(asksForNote('what did we decide about deploys?')).toBe(false)
  })
})

describe('namesSubject', () => {
  it('sees a pointer and a verb as naming nothing', () => {
    expect(namesSubject('그거 처리해줘')).toBe(false)
    expect(namesSubject('그거 다시 해줘')).toBe(false)
    expect(namesSubject('handle that')).toBe(false)
    expect(namesSubject('just do it')).toBe(false)
  })
  it('sees a subject when one is named', () => {
    expect(namesSubject('포털 공지 확인해줘')).toBe(true)
    expect(namesSubject('오늘 업무일지 올려줘')).toBe(true)
    expect(namesSubject('what did we decide about deploys?')).toBe(true)
  })
})

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
