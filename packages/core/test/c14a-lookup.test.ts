import { describe, expect, it } from 'vitest'
import { navigationTools } from '../src/comet-navigation-tools.js'
import type { CometToolDeps } from '../src/comet-tools.js'
import { handBacks } from '../src/company-tools.js'
import type { MemberData, TeamMember } from '../src/delegated-tasks.js'
import { ANSWER_FROM_THIS, keepRead, keepSources, LOOKUP_CALL_MS, LOOKUP_ROUND_MS, LOOKUP_RULE, settleMember, TEAM_ANSWER_MS, timeBoxed } from '../src/team-hire-tools.js'

const ASK = '국내 로봇 스타트업 인수 뉴스 4개'
const row = (n: number, title: string) => ({ title, url: `https://press-${n}.example/${n}`, says: `로봇 업계 소식 ${n}`, when: `${n}일 전` })
function finder(rows: ReturnType<typeof row>[]) {
  const fetched: string[] = []
  const fetchPage = async (url: string, signal?: AbortSignal) => {
    fetched.push(url)
    if (signal?.aborted) throw new Error('stopped')
    return { url, title: '', text: rows.map(one => `${one.title}\n${one.says}\n`).join('\n'), links: rows.flatMap(one => [{ text: one.title, url: one.url }, { text: one.when, url: one.url }]) }
  }
  const tool = navigationTools({ courier: { fetchPage }, guided: false, searchTemplate: async () => 'https://find.example/?q={q}' } as unknown as CometToolDeps).find(one => one.name === 'search_web')!
  return { fetched, tool }
}
const addresses = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
const four = [row(1, '로봇 스타트업 모션웍스 인수 완료'), row(2, '물류 로봇 스타트업 인수 계약 체결'), row(3, '로봇 스타트업 인수 바람, 업계 전망'), row(4, '로봇 스타트업 자금 한파에도 인수 문의')]
const member = (id: string, role: string, brief: string, data: MemberData): TeamMember => {
  const m: TeamMember = { id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'working', sessionKey: `s-${id}`, hiredAt: new Date().toISOString() }
  settleMember(m, { answer: data.facts.map(f => `${f.text} — ${f.url}`).join('\n'), sources: data.facts.map(f => f.url) }, new Date().toISOString(), true)
  return m
}

describe('c14a: a counted lookup looks further only by the reader\'s own choice, on the one deadline', () => {
  it('4 rows seen for 4 asked: one search, and every row, a plain deal or a row that only touches the topic, goes to the reader', async () => {
    const { tool, fetched } = finder(four)
    const out = await tool.run({ query: ASK }, { task: ASK })
    expect(fetched).toHaveLength(1)
    expect(addresses(out).sort()).toEqual(four.map(one => one.url).sort())
    expect(out).toContain('They asked for 4')
    expect(out).not.toMatch(/The first \d+ are from the last|None is from the last/)
  })

  it('the reader is told to search once more while rows are short; each call runs while time for it is left and the last one that fits closes the looking', async () => {
    let now = 0
    const due = TEAM_ANSWER_MS
    const { tool, fetched } = finder(four.slice(0, 2))
    const boxed = timeBoxed(tool, () => due - now)
    const first = await boxed.run({ query: ASK }, { task: ASK })
    expect(first).toContain('When fewer than 4 are here, search once more in other words before you answer.')
    expect(first).not.toContain(ANSWER_FROM_THIS)
    now = due - LOOKUP_ROUND_MS + 1
    const second = await boxed.run({ query: '로봇 기업 합병 뉴스' }, { task: ASK })
    expect(addresses(second)).toHaveLength(2)
    expect(second.endsWith(ANSWER_FROM_THIS)).toBe(true)
    now = due - LOOKUP_CALL_MS + 1
    expect(await boxed.run({ query: '로봇 벤처 매각 뉴스' }, { task: ASK })).toBe(ANSWER_FROM_THIS)
    expect(fetched).toHaveLength(2)
  })

  it('other words are the teammate\'s to pick, never a third search; a short count reaches the result step as the finds themselves, and saying what is missing is the note\'s rule', () => {
    expect(LOOKUP_RULE).toContain('search once more in other words before you report')
    expect(LOOKUP_RULE).toContain('never a third time')
    const facts = [1, 2].map(n => ({ text: `로봇 회사 ${n}곳이 인수됐어요.`, url: `https://press-${n}.example/${n}`, site: '로봇신문' }))
    const { reports, note } = JSON.parse(handBacks([member('m1', '한결', ASK, { facts })])) as { reports: { who: string; result: string; sources: string[] }[]; note: string }
    expect(reports[0]!.who).toBe('한결')
    expect(reports[0]!.result.split('\n')).toHaveLength(2)
    expect(reports[0]!.sources).toEqual(facts.map(f => f.url))
    expect(note).toContain('Say plainly which part failed or is missing')
  })

  it('every row a search returns is kept for the teammate in the search\'s order, and the results page is noted as read', async () => {
    const rows = [row(1, '로봇 스타트업 인수 동향 정리'), row(2, '로봇 스타트업 알파봇 인수'), row(3, '로봇 스타트업 베타암 인수'), row(4, '로봇 스타트업 감마휠 인수'), row(5, '로봇 스타트업 델타핸드 인수')]
    const read: string[] = [], seen = new Set<string>()
    const out = await keepSources(keepRead(finder(rows).tool, read), seen).run({ query: ASK }, { task: '로봇 스타트업 인수 뉴스 3개' })
    const shown = addresses(out)
    expect([...shown].sort()).toEqual(rows.map(one => one.url).sort())
    expect(read).toHaveLength(1)
    expect([...read[0]!.matchAll(/https:\/\/press-\d\.example\/\d/g)].map(one => one[0])).toEqual(shown)
    expect([...seen]).toEqual([`https://find.example/?q=${encodeURIComponent(ASK)}`])
  })

  it('the deadline is the one clock: a call made 15 s into the turn still runs whole, with no closing line', async () => {
    const { tool, fetched } = finder(four)
    const began = 0, now = 15_000
    const out = await timeBoxed(tool, () => began + TEAM_ANSWER_MS - now).run({ query: ASK }, { task: ASK })
    expect(TEAM_ANSWER_MS - now).toBeGreaterThanOrEqual(LOOKUP_ROUND_MS)
    expect(fetched).toHaveLength(1)
    expect(out).not.toContain(ANSWER_FROM_THIS)
    expect(addresses(out)).toHaveLength(4)
  })

  it('a stopped turn starts no further search', async () => {
    const stop = new AbortController()
    const { tool, fetched } = finder(four)
    stop.abort()
    await expect(tool.run({ query: ASK }, { task: ASK, signal: stop.signal })).rejects.toThrow('stopped')
    expect(fetched).toHaveLength(1)
  })

  it('a row whose title does not say enough is the reader\'s to open: the search says so in its own lines and the lookup rule opens a page only for what no row shows', async () => {
    const out = await finder(four).tool.run({ query: ASK }, { task: ASK })
    expect(out).toContain('When a title does not say enough, open the article (read_pages).')
    expect(out).toContain('open one (read_pages for several) only for a number none of them shows')
    expect(LOOKUP_RULE).toContain('open a page only for a number none of them shows')
  })
})

describe('a teammate\'s facts reach the result step one by one', () => {
  it('two wordings of the same event and a page that lists several are all handed back, each on its own line with its own page', () => {
    const page = 'https://stage.example.kr/busan/spring'
    const data: MemberData = { facts: [
      { text: '부산 시립 무용단 봄 정기 공연이 4월 11일에 열려요.', url: page, site: '시립', date: '4월 11일' },
      { text: '시립 무용단 봄 공연, 4월 11일 저녁이에요.', url: `${page}/0411`, site: '시립', date: '4월 11일' },
      { text: '부산 봄 공연 모음이에요.', url: 'https://stage.example.kr/busan', site: '시립', listing: true, name: '공연 모음' },
    ] }
    const m = member('m1', '소담', '부산 봄 공연 일정', data)
    const { reports } = JSON.parse(handBacks([m])) as { reports: { result: string; sources: string[] }[] }
    expect(reports[0]!.result.split('\n')).toHaveLength(3)
    for (const fact of data.facts) expect(reports[0]!.result).toContain(fact.url)
    expect(reports[0]!.sources).toEqual(data.facts.map(f => f.url))
  })
})
