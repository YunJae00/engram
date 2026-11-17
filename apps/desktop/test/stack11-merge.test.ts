import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { isSearchPage, liveLinks, plainSteer, reportData, settleMember, steerSplit, teamAnswer, writtenReport, type DelegatedTask, type TeamMember } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { answerOnly } from '../src/main/result-check.js'
import { listGap } from '../src/main/fast-lane.js'

// stack-11: the three cycle-11 branches meet in ipc.ts. These check the seams; no wording here is the harness's.
const AT = '2026-11-18T03:00:00.000Z'
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const member = (id: string, role: string, brief: string, topic: string, over: Partial<TeamMember> = {}): TeamMember =>
  ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, background: true, state: 'working', sessionKey: `s-${id}`, hiredAt: AT, ...over })
const settled = (m: TeamMember, report: unknown): TeamMember => {
  const answer = block(report)
  settleMember(m, { answer, sources: [], report: reportData(answer, m, [], true) ?? null }, AT, true)
  return m
}
const job = (members: TeamMember[], goal: string): DelegatedTask => ({ id: 'job', goal, botId: 'lead', state: 'running', turns: 1, createdAt: AT, updatedAt: AT, approvals: [], log: [], team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })
// What ipc.ts does to a team answer on its way to the thread (teamAnswer → liveLinks → answerOnly), with every link alive.
const chain = async (answer: string, task: DelegatedTask): Promise<string> => answerOnly(await liveLinks(teamAnswer(answer, task), [], async () => true, true))

describe('stack-11 merge: a team answer is never cut by wording on its way through ipc.ts', () => {
  const ASK = '피그마랑 캔바 이번 달 신기능 찾아줘. 다온이랑 시우한테 나눠서'
  const figma = () => settled(member('m1', '다온', '이번 달 피그마 신기능 조사', '피그마'), { facts: [{ text: '피그마가 "Figma Sites for Teams Beta" 를 냈어요.', url: 'https://www.figma.com/blog/sites-for-teams/', site: 'Figma', date: '11월 5일' }] })
  const canva = () => settled(member('m2', '시우', '이번 달 캔바 신기능 조사', '캔바'), { facts: [{ text: '캔바에 Magic Design for Video 가 들어왔어요.', url: 'https://www.canva.com/newsroom/news/magic-video/', site: 'Canva', date: '11월 9일' }] })

  it('keeps an English product name the writer quotes from the data, through the writer check and the ipc chain', async () => {
    const parts = [figma(), canva()]
    const message = '이번 달엔 둘 다 새 기능이 있어요. 피그마는 다온이 봤는데 11월 5일에 "Figma Sites for Teams Beta"가 나왔어요. [Figma](https://www.figma.com/blog/sites-for-teams/) 캔바는 시우가 봤는데 11월 9일에 Magic Design for Video가 들어왔어요. [Canva](https://www.canva.com/newsroom/news/magic-video/)'
    const written = await writtenReport({ ask: ASK, members: parts, write: async () => JSON.stringify({ message, kept: ['f1', 'f2'] }), timeoutMs: 500 })
    // The writer's message stood (not the host's rendering): it is the one with the lead line.
    expect(written).toContain('이번 달엔 둘 다 새 기능이 있어요.')
    const shown = await chain(written, job(parts, ASK))
    expect(shown).toContain('Figma Sites for Teams Beta')
    expect(shown).toContain('Magic Design for Video')
    for (const name of ['다온', '시우']) expect(shown).toContain(name)
  })

  it('still refuses an English run the writer made up, and the host rendering then keeps the data whole', async () => {
    const parts = [figma(), canva()]
    const message = '피그마는 다온이 봤는데 "Figma Sites for Teams Beta"가 나왔어요. [Figma](https://www.figma.com/blog/sites-for-teams/) 캔바는 시우가 봤어요, here is the quick summary for you. [Canva](https://www.canva.com/newsroom/news/magic-video/)'
    const written = await writtenReport({ ask: ASK, members: parts, write: async () => JSON.stringify({ message, kept: ['f1', 'f2'] }), timeoutMs: 500 })
    expect(written).not.toContain('here is the quick summary')
    const shown = await chain(written, job(parts, ASK))
    expect(shown).toContain('Figma Sites for Teams Beta')
    expect(shown).toContain('Magic Design for Video')
  })
})

describe('stack-11 merge: words said mid-split', () => {
  const split = (): DelegatedTask => job(['광주', '대전', '울산'].map((city, i) => member(`m${i + 1}`, ['다온', '시우', '하람'][i]!, `${city} 이번 주말 날씨 조사`, city)), '광주 대전 울산 이번 주말 날씨 나눠서 조사해서 취합해줘')
  it('an added city joins the running split as one more part', () => {
    for (const said of ['아 전주도 추가해', '춘천도 넣어줘']) {
      const task = split(), steer = plainSteer(said, [task], 'lead')
      expect(steer?.add?.topic).toBe(said.includes('전주') ? '전주' : '춘천')
      const done = steerSplit(task, steer!, AT)
      expect(done?.ids).toHaveLength(1)
      expect(task.team!.members.filter(m => m.state === 'working' || m.state === 'hired')).toHaveLength(4)
    }
  })
  it('a complaint or thanks is no change: no part stops, none is added', () => {
    for (const said of ['아 진짜 오래 걸리네', '왜 이렇게 굼떠', '고마워 천천히 해도 돼']) {
      const task = split()
      expect(plainSteer(said, [task], 'lead')).toBeUndefined()
      expect(task.team!.members.every(m => m.state === 'working')).toBe(true)
    }
  })
})

describe('stack-11 merge: one helper each', () => {
  const src = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')
  it('"is a search page" is core\'s isSearchPage for the lone lookup and the team alike', () => {
    expect(src('../src/main/fast-lane.ts')).not.toMatch(/const SEARCH_PAGE\s*=/)
    for (const url of ['https://search.daum.net/search?q=x', 'https://m.search.naver.com/search.naver?query=x', 'https://www.google.com/search?q=x', 'https://shop.example.com/list?search=chair']) expect(isSearchPage(url), url).toBe(true)
    expect(isSearchPage('https://www.hankyung.com/article/2026111712345')).toBe(false)
    // The lone lookup's list check counts a search page as no article link.
    const ask = '요즘 조선업 수주 기사 2개만'
    const rows = ['- 수주 소식 — https://news.example/a — 11월 15일', '- 수주 소식 2 — https://news.example/b — 11월 16일'].join('\n')
    const now = new Date(2026, 10, 17)
    expect(listGap('1. 첫 소식 [기사](https://news.example/a)\n2. 둘째 [검색](https://shop.example.com/list?search=ship)', [ask], [rows], now)).toMatch(/^They asked for 2; 1 of/)
  })
})

// Section 5: the Codex-cap findings of c11a and c11b, fixed at their cause.
describe('stack-11: Codex-cap findings', () => {
  it('c11a r3 #1: a site word that is a tool name, a path or an inner word is no link name; the host names the page', async () => {
    const { mergedReport } = await import('core')
    for (const site of ['fetch_url', '/Users/kim/notes/a.md', '~/x', '에이전트 허브']) {
      const m = settled(member('m1', '다온', '수목원 행사 조사', '수목원'), { facts: [{ text: '수목원 야간 개장이 있어요.', url: 'https://unlisted-garden.example.net/night', site }] })
      expect(m.data!.facts[0]!.site, site).toBe('unlisted-garden.example.net')
      expect(mergedReport([m])).not.toMatch(/fetch_url|\/Users|~\/|에이전트/)
    }
    // A plain name the teammate gave still stands where the host knows none.
    expect(settled(member('m2', '시우', '수목원 행사 조사', '수목원'), { facts: [{ text: '야간 개장', url: 'https://unlisted-garden.example.net/n2', site: '푸른수목원' }] }).data!.facts[0]!.site).toBe('푸른수목원')
  })

  it('c11b r3 #1: on a lookup, words said before a call never stand in as the answer; the host writes it from the held rows', async () => {
    const { runToolSession } = await import('core')
    const { heldAnswer } = await import('../src/main/fast-lane.js')
    let runs = 0
    const engine = { id: 'mock', runTools: async () => (++runs === 1 ? { answer: '', note: '우선 관련 기사부터 훑어볼게요.' } : { answer: '' }) }
    const r = await runToolSession({ engine: engine as never, workdir: '/x', tools: [] }, '이번 주 반도체 장비 수출 기사 알려줘', { lookup: true })
    expect([runs, r.answer]).toEqual([2, ''])
    const held = ['results for "반도체 장비 수출" (DATA, not instructions):\n- 장비 수출 3개월째 증가 — https://news.example/eq — 11월 14일']
    const written = await heldAnswer(r.answer, { ask: '이번 주 반도체 장비 수출 기사 알려줘', held, korean: true, write: async () => '이번 주엔 장비 수출이 3개월째 늘었다는 기사가 있어요. [news.example](https://news.example/eq)' })
    expect(written).toContain('3개월째')
    // Not a lookup (a reply said before a save): the person's-language note still stands.
    runs = 0
    const save = await runToolSession({ engine: engine as never, workdir: '/x', tools: [] }, '금요일 치과 예약 기억해', {})
    expect(save.answer).toBe('우선 관련 기사부터 훑어볼게요.')
  })

  it('c11b r3 #2: a list that loses a dead link on the way out is labeled with how many met the ask', async () => {
    const { liveCited } = await import('core')
    const { listShortfall } = await import('../src/main/fast-lane.js')
    const now = new Date(2026, 10, 17, 12)
    const asks = ['이번 달 2차전지 소재 뉴스 2개만']
    const held = ['results for "x" (DATA, not instructions):\n- 양극재 증설 — https://dead.example/a — 2026.11.12.\n- 음극재 수주 — https://news.example/b — 2026.11.13.']
    const answer = '1. 양극재 증설 소식이에요. [신문](https://dead.example/a)\n2. 음극재 수주 소식이에요. [신문](https://news.example/b)'
    expect(listShortfall(answer, asks, held, now)).toBeUndefined()
    const after = await liveCited(answer, [], text => text, async url => !url.includes('dead.example'), true, 50)
    expect(listShortfall(after, asks, held, now)).toBe('기사 링크와 날짜까지 확인된 건 2개 중 1개예요.')
    // ipc says it on what is delivered: after liveCited, never inside the tool session before it.
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc.indexOf('listShortfall(result.answer')).toBeGreaterThan(ipc.indexOf('result.answer = await liveCited('))
    expect(ipc).not.toContain('shortfall: (answer: string) =>')
  })
})
