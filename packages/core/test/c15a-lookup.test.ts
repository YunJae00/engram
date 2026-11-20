import { describe, expect, it } from 'vitest'
import { navigationTools } from '../src/comet-navigation-tools.js'
import type { CometToolDeps } from '../src/comet-tools.js'
import { askedCount as partCount, handBacks } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { askedCount, searchResults, withoutRepeats } from '../src/search-template.js'
import { ANSWER_FROM_THIS, LOOKUP_CALL_MS, LOOKUP_ROUND_MS, settleMember, sourceName, timeBoxed } from '../src/team-hire-tools.js'

type Row = { title: string; url: string; says: string }
const row = (n: number, title: string, host = `daily-${n}.example`): Row => ({ title, url: `https://${host}/${n}`, says: `전통시장 소식 ${n}` })
const page = (rows: Row[]) => ({ text: rows.map(one => `${one.title}\n${one.says}\n`).join('\n'), links: rows.map(one => ({ text: one.title, url: one.url })) })
function finder(rows: Row[], fetchPage: (url: string, signal?: AbortSignal) => Promise<unknown> = async url => ({ url, title: '', ...page(rows) })) {
  const fetched: string[] = []
  const tool = navigationTools({ courier: { fetchPage: (url: string, signal?: AbortSignal) => { fetched.push(url); return fetchPage(url, signal) } }, guided: false, searchTemplate: async () => 'https://find.example/?q={q}' } as unknown as CometToolDeps).find(one => one.name === 'search_web')!
  return { fetched, tool }
}
const addresses = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
const ASK = '전통시장 야시장 개장 뉴스 4개만'
const four = [row(1, '서문 전통시장 야시장 개장'), row(2, '남부 전통시장 야시장 개장 확정'), row(3, '전통시장 야시장 개장 붐, 상인들 기대'), row(4, '전통시장 야시장 개장 검토 중인 곳들')]

describe('c15a: a counted lookup hands on every row; which ones count is the reader\'s call', () => {
  it('2 plain rows and 2 that only touch the topic, for 4 asked: all 4 are results, none dropped as a repeat of another', () => {
    const { text, links } = page(four)
    const listed = searchResults(links, text, ASK, 'https://find.example/?q=x', 16)
    expect(listed.map(one => one.url).sort()).toEqual(four.map(one => one.url).sort())
    expect(listed.map(one => one.snippet).sort()).toEqual(four.map(one => one.says).sort())
    expect(withoutRepeats(listed, ASK)).toHaveLength(4)
  })

  it('4 rows for 4 asked: the search writes its count line once and no line about a shortfall or an older period', async () => {
    const { tool, fetched } = finder(four)
    const out = await tool.run({ query: ASK }, { task: ASK })
    expect(fetched).toHaveLength(1)
    expect(addresses(out)).toHaveLength(4)
    expect(out.split('They asked for 4')).toHaveLength(2)
    expect(out).not.toMatch(/are from the last|None is from the last|came back empty/)
  })

  it('more rows than asked: every row is shown; the search counts only news-style counters, and a teammate\'s part counts 2 to 10 of its own', async () => {
    for (const [ask, n] of [['주말 야시장 먹거리 뉴스 2개', 2], ['야시장 축제 뉴스 5건 알려줘', 5]] as const) {
      const rows = Array.from({ length: n + 1 }, (_, i) => row(i + 1, `야시장 먹거리 축제 뉴스 ${i + 1}탄`))
      const out = await finder(rows).tool.run({ query: ask }, { task: ask })
      expect(addresses(out), ask).toHaveLength(n + 1)
      expect(out, ask).toContain(`They asked for ${n}: list the ${n} rows`)
    }
    expect(askedCount('여행 에세이 2권 추천')).toBeUndefined()
    expect(askedCount('전주 국밥집 5곳 알려줘')).toBeUndefined()
    expect(partCount('홍보 문구 세 줄 써줘')).toBe(3)
    expect(partCount('야시장 소식 12개')).toBe(0)
    expect(partCount('야시장 일정 알려줘')).toBe(0)
  })

  it('second-hand rows: a blog or café post is listed after the other results, and such a page is named by its platform', () => {
    const rows = [row(1, '별빛폰 출시일 정리한 글', 'blog.naver.com'), row(2, '별빛전자, 별빛폰 출시일 3월 9일 확정', 'maker.example'), row(3, '별빛폰 출시일 떴네요', 'cafe.naver.com')]
    const { text, links } = page(rows)
    const listed = searchResults(links, text, '별빛폰 출시일', 'https://find.example/?q=x')
    expect(listed[0]!.url).toBe('https://maker.example/2')
    expect(listed.slice(1).map(one => one.url).sort()).toEqual(['https://blog.naver.com/1', 'https://cafe.naver.com/3'])
    expect(sourceName('https://blog.naver.com/1', true)).toBe('네이버 블로그')
    expect(sourceName('https://cafe.naver.com/3', true)).toBe('네이버 카페')
  })

  it('a first-hand fact and a second-hand one about the same thing are both handed back, in the order the teammate gave them, with the pages it read', () => {
    const blog = { text: '달맞이 수영장이 5월 3일에 다시 연대요.', url: 'https://blog.example/7', site: '블로그' }
    const city = { text: '달맞이 수영장은 5월 3일에 재개장해요.', url: 'https://city.example/news/3', site: '구청' }
    const other = { text: '해맞이 체육관은 6월에 공사를 마쳐요.', url: 'https://city.example/news/4', site: '구청' }
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '이든', brief: '구립 체육시설 재개장 소식', botId: 'bot-m1', lookup: true, state: 'working', sessionKey: 's', hiredAt: new Date().toISOString() }
    settleMember(m, { answer: [blog, city, other].map(f => `${f.text} — ${f.url}`).join('\n'), sources: [blog.url, city.url, other.url] }, new Date().toISOString(), true)
    const { reports } = JSON.parse(handBacks([m])) as { reports: { result: string; sources: string[] }[] }
    expect(reports[0]!.result.split('\n').map(line => line.split(' — ')[1])).toEqual([blog.url, city.url, other.url])
    expect(reports[0]!.sources).toEqual([blog.url, city.url, other.url])
    for (const fact of [blog, city, other]) expect(reports[0]!.result).toContain(fact.text)
  })

  it('"멈춰" while a search is loading ends it at once; no further search starts', async () => {
    const stop = new AbortController()
    const { tool, fetched } = finder(four, (_url, signal) => new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); setTimeout(() => stop.abort(), 50) }))
    const started = Date.now()
    await expect(tool.run({ query: ASK }, { task: ASK, signal: stop.signal })).rejects.toThrow('stopped')
    expect(Date.now() - started).toBeLessThan(500)
    expect(fetched).toHaveLength(1)
  })

  it('a helper\'s search reads its own deadline: with 8 s of it left the search runs and is the last, and under the time one call needs it does not run', async () => {
    const due = 9_000
    let now = 1_000
    const { tool, fetched } = finder(four)
    const boxed = timeBoxed(tool, () => due - now)
    const out = await boxed.run({ query: ASK }, { task: ASK })
    expect(due - now).toBeLessThan(LOOKUP_ROUND_MS)
    expect(addresses(out)).toHaveLength(4)
    expect(out.endsWith(ANSWER_FROM_THIS)).toBe(true)
    now = due - LOOKUP_CALL_MS + 1
    expect(await boxed.run({ query: ASK }, { task: ASK })).toBe(ANSWER_FROM_THIS)
    expect(fetched).toHaveLength(1)
  })
})
