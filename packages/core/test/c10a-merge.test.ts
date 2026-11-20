import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { COLLEAGUE_CORE_RULE } from '../src/agent-voice.js'
import * as hire from '../src/team-hire-tools.js'
import { employeesAnswer, handBacks, LOOKUP_RULE, MERGED_SHAPE, settleMember, sourceName, teamHireTools, type DelegatedTask, type TeamHost, type TeamMember } from '../src/index.js'

interface Handed { members: { role: string; state: string; result: string; sources?: string[] }[]; note: string }
type Helper = Pick<TeamMember, 'role' | 'brief' | 'result' | 'sources'>
const AT = '2026-11-17T00:00:00Z'
async function hired(helpers: readonly Helper[], answered = false): Promise<Handed> {
  const task = { id: 't', goal: '가격 비교', botId: 'lead', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [] } as DelegatedTask
  const host: TeamHost = {
    self: null, load: async () => task, change: async work => work(task),
    run: async ids => {
      for (const m of task.team!.members.filter(one => ids.includes(one.id))) {
        const from = helpers.find(one => one.role === m.role)!
        if (answered) settleMember(m, { answer: from.result!, sources: from.sources ?? [] }, AT, true)
        else Object.assign(m, { state: 'done', result: from.result, ...(from.sources ? { sources: from.sources } : {}) })
      }
    },
    release: async ids => { for (const m of task.team!.members) if (ids.includes(m.id)) m.state = 'released' },
    live: () => false, tokensLeft: async () => 1_000_000, personSaid: () => '',
  }
  return JSON.parse(await teamHireTools(host)[0]!.run({ members: helpers.map(h => ({ role: h.role, brief: h.brief, lookup: true })) }, { task: '' })) as Handed
}

const r2 = JSON.parse(readFileSync(new URL('./fixtures/c10a-r2-helpers.json', import.meta.url), 'utf8')) as { members: TeamMember[] }

test('c10a R2 (c12b: every value stays, labeled) → k1: the stored helpers reach the lead with every word and page they reported, and the lead is told to keep each value and to name each page by its site', async () => {
  const out = await hired(r2.members)
  expect(out.members.map(m => m.result)).toEqual(r2.members.map(m => m.result))
  expect(out.members.map(m => m.sources)).toEqual(r2.members.map(m => m.sources))
  for (const figure of ['999달러', '187만원', '999유로', '199만 원']) expect(JSON.stringify(out.members)).toContain(figure)
  expect(out.note).toContain(MERGED_SHAPE)
  expect(MERGED_SHAPE).toContain('Every concrete value a member reported stays in its row, labeled as the member labeled it')
  expect(out.note).toContain('[site name](address), with the address copied exactly from sources')
  expect(out.note).toContain('never a site name alone')
  expect(sourceName('https://www.mt.co.kr/tech/2026/10/20/2026101915464770051', true)).toBe('머니투데이')
  expect(sourceName('https://ko.vidabytes.com/a', true)).toBe('ko.vidabytes.com')
})

test('c10a R2 (c12b) → k1: a line naming any tier reaches the lead as the helper wrote it; a known outlet is named (c11a: an unknown site by its host)', async () => {
  const lines = ['프로 기준 249만 원부터', '미발표 (전작 서피스 11 139만 원)', '미발표, 예상 1,099달러, 플러스는 1,299달러']
  const helpers = lines.map((line, i) => ({ role: `노트북 ${i + 1}`, brief: `서피스 ${i + 12} 가격 조사`, result: `가격: ${line} — https://laptop.example.kr/p/${i}` }))
  const out = await hired(helpers)
  expect(out.members.map(m => m.result)).toEqual(helpers.map(h => h.result))
  expect(MERGED_SHAPE).toContain('never dropped or turned into "미발표"')
  for (const [url, name] of [['https://news.mt.co.kr/mtview.php?no=1', '머니투데이'], ['https://www.asiae.co.kr/article/1', '아시아경제'], ['https://biz.chosun.com/it/1', '조선비즈'], ['https://www.chosun.com/economy/1', '조선일보'], ['https://www.yna.co.kr/view/1', '연합뉴스']] as const)
    expect(sourceName(url, true), url).toBe(name)
  expect(sourceName('https://unknown-site.example/a', true)).toBe('unknown-site.example')
})

test('c10a r2 (c12b: values of another model stay, labeled, and so does the page they came from) → k1: each helper\'s answer is its result, with every address it wrote and the pages it read', async () => {
  const search = 'https://search.naver.com/search.naver?query=x'
  const helpers: Helper[] = [
    { role: '자전거', brief: '로드 자전거 에어 9 가격', result: '가격: 에어 9 카본 모델 389만 원부터 — https://news.example.kr/air9-carbon\n에어 9 알루미늄은 179만 원부터예요 — https://shop.example.kr/item/41', sources: [search, 'https://shop.example.kr/item/41'] },
    { role: '텐트', brief: '돔 텐트 4 가격', result: '돔 텐트 4 대형 모델이 64만 원이에요. — https://blog.example.kr/tent/4', sources: [search] },
  ]
  const out = await hired(helpers, true)
  expect(out.members.map(m => m.result)).toEqual(helpers.map(h => h.result))
  for (const address of ['https://news.example.kr/air9-carbon', 'https://shop.example.kr/item/41', 'https://blog.example.kr/tent/4']) expect(JSON.stringify(out.members)).toContain(address)
  expect(out.members[0]!.sources).toEqual(['https://shop.example.kr/item/41', search])
  expect(LOOKUP_RULE).toContain('names what it belongs to')
})

test('c10a r2 → k1: no page is fetched to rename a link after the answer: an unknown site is named by its host, and naming a source with its link is the writer\'s rule', () => {
  expect(Object.entries(hire).filter(([name, value]) => typeof value === 'function' && /link|cite|live|declared|page/i.test(name)).map(([name]) => name).sort()).toEqual(['figurePages', 'isSearchPage', 'withLiveSources'])
  expect(sourceName('https://breadmap.example/a/2', true)).toBe('breadmap.example')
  expect(sourceName('https://m.trailnote.example/p', true)).toBe('m.trailnote.example')
  expect(LOOKUP_RULE).toContain('a site whose name you do not know is named by its host as written in the address')
  expect(COLLEAGUE_CORE_RULE).toContain('with the address copied exactly from what a tool returned')
  expect(COLLEAGUE_CORE_RULE).toContain('never a site name without its link')
})

test('c10a r3 (c12b: no page is dropped for being another model\'s) → k1: a teammate who cited several pages hands back each of them, and the lead is told to link what each backs', () => {
  const member = (role: string, brief: string, result: string): TeamMember => ({ id: role, parentId: null, depth: 1, role, brief, sessionKey: role, hiredAt: '2026-11-17T00:00:00Z', state: 'released', lookup: true, sources: ['https://search.naver.com/search.naver?query=y'], result })
  const oven = member('오븐', '미니 오븐 5 가격', '미니 오븐 5는 18만 원부터 — https://news.example.kr/oven5\n미니 오븐 5 스팀은 27만 원 — https://review.example.kr/oven-5-steam')
  const mixer = member('반죽기', '반죽기 8 가격', '반죽기 8 대용량 모델 96만 원 — https://blog.example.kr/mixer8-a\n반죽기 8 가정용은 58만 원 — https://blog.example.kr/mixer8-b')
  const out = JSON.parse(handBacks([oven, mixer])) as { reports: { who: string; result: string; sources: string[] }[]; note: string }
  expect(out.reports.map(r => [r.who, r.result])).toEqual([['오븐', oven.result], ['반죽기', mixer.result]])
  expect(out.reports[0]!.result).toMatch(/oven5[^]*oven-5-steam/)
  expect(out.reports[1]!.result).toMatch(/mixer8-a[^]*mixer8-b/)
  expect(out.reports.map(r => r.sources)).toEqual([oven.sources, mixer.sources])
  expect(out.note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result, never a site name alone')
})

test('stack-10 (c10a r3; c12b) → k1: a tier bracket and the price it labels stay in the helper\'s line when its answer is settled, so the value says whose it is', () => {
  for (const cell of ['249만 원부터 (프로 기준)', '미발표 (예상 74만 원대), 118만 원부터 (대형 모델)', '86만 원 (스팀은 127만 원)', '31만 원 (접이식 기준) / 22만 원 (기본형)', '143만 원 (카본 기준)']) {
    const m: TeamMember = { id: 'h', parentId: null, depth: 1, role: '가격', brief: '캠핑 화로 3 가격 조사', sessionKey: 'h', hiredAt: AT, state: 'working', lookup: true }
    settleMember(m, { answer: `가격: ${cell}`, sources: ['https://camp.example.kr/fire3'] }, AT, true)
    expect(m.result).toBe(`가격: ${cell}`)
    expect(m.said).toBe(`가격: ${cell}`)
    expect(m.data).toBeUndefined()
  }
})
test('stack-10 (c12b) → k1: a tier bracket that speaks about that tier stays beside the base figure in what the lead is handed', () => {
  for (const cell of ['47만 원부터 (대형은 아직 미정)', '47만 원부터 (대형 모델)']) {
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '보람', botId: 'bot-1', background: true, brief: '등산 배낭 9 가격 조사', sessionKey: 's', hiredAt: AT, state: 'done', lookup: true, result: `가격: ${cell}` }
    const task = { id: 't', goal: 'g', botId: 'lead', state: 'waiting', turns: 1, createdAt: AT, updatedAt: AT, approvals: [], log: [], team: { members: [m], hires: 1, maxHires: 8, maxDepth: 3, big: false } } as DelegatedTask
    expect((JSON.parse(employeesAnswer(task)!) as { reports: { result: string }[] }).reports[0]!.result).toBe(`가격: ${cell}`)
  }
})
