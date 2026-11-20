import { describe, expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runComet } from '../src/agent-session.js'
import { formatAsk } from '../src/ask.js'
import { firstSearches, handBacks, partOutcome } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { MockEngine } from '../src/engine/mock.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'
import * as core from '../src/index.js'
import { ANSWER_FROM_THIS, keepRead, keepSources, LOOKUP_CALL_MS, LOOKUP_ROUND_MS, LOOKUP_RULE, settleMember, skipWalls, timeBoxed } from '../src/team-hire-tools.js'

const page = (query: string, rows: string[], words = ''): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows, ...(words ? ['', words] : [])].join('\n')
const row = (url: string, title: string, snippet?: string): string => `- ${title} — ${url}${snippet ? ` — ${snippet} — 11월 20일` : ''}`
function search(outs: string[], tick?: () => void): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); tick?.(); return outs.shift() ?? page(String(args['query']), []) } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
interface Move { tool: string; args: Record<string, unknown> }
interface Looked { got: string[]; answer: string; jobs: ToolSessionJob[]; sources: string[]; kept: string[] }
async function looked(ask: string, tools: AgentTool[], moves: Move[], draft: string, left: () => number = () => 20_000, signal?: AbortSignal): Promise<Looked> {
  const got: string[] = [], jobs: ToolSessionJob[] = [], sources = new Set<string>(), kept: string[] = []
  const engine = {
    id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () { yield { type: 'result', text: '' } },
    runTools: async (job: ToolSessionJob): Promise<ToolSessionResult> => {
      jobs.push(job)
      for (const move of moves) { const out = await job.tools.find(tool => tool.name === move.tool)!.run(move.args); got.push(typeof out === 'string' ? out : out.text) }
      return { answer: draft }
    },
  } as unknown as Engine
  const boxed = tools.map(tool => timeBoxed(keepRead(keepSources(skipWalls(tool), sources), kept), left))
  const result = await runComet({ engine, workdir: 'C:/tmp' as EngineCwd, tools: boxed }, ask, { guided: false, lookup: true, ...(signal ? { signal } : {}) })
  return { got, answer: result.answer, jobs, sources: [...sources], kept }
}
async function stepped(ask: string, tools: AgentTool[], moves: Move[], draft: string): Promise<{ prompts: string[]; seen: string[]; answer: string }> {
  const prompts: string[] = [], plan = [...moves]
  const engine = new MockEngine({ default: prompt => { prompts.push(prompt); return JSON.stringify(plan.shift() ?? { tool: 'answer', args: { text: draft } }) } }, { gapMs: 0 })
  const result = await runComet({ engine, workdir: 'C:/tmp' as EngineCwd, tools }, ask, { guided: false })
  return { prompts, seen: result.steps.map(step => step.observation), answer: result.answer }
}
const Q = { tool: 'search_web', args: { query: 'q' } }
type Item = { title?: string; text: string }
const asRows = (items: readonly Item[]): string[] => items.map((item, i) => { const [head, ...rest] = item.text.split(' — '); return `- ${head} — https://item.example/${i + 1}${rest.length ? ` — ${rest.join(' — ')}` : ''}` })
const passed = async (ask: string, items: readonly Item[]): Promise<{ jobs: number; out: string; found: string; kept: string }> => {
  const found = page('q', asRows(items))
  const seen = await looked(ask, [search([found])], [Q], 'x')
  return { jobs: seen.jobs.length, out: seen.got[0]!, found, kept: seen.kept[0]! }
}
const opener = (pages: Record<string, string>): AgentTool & { opened: string[] } => {
  const opened: string[] = []
  return { opened, name: 'open_page', description: '', argsSchema: {}, run: async args => { opened.push(String(args['url'])); return pages[String(args['url'])] ?? 'that did not work: no such page' } }
}
const at = new Date().toISOString()
const settled = (topic: string, brief: string, said: string, sources: string[] = []): TeamMember => {
  const m: TeamMember = { id: topic, parentId: null, depth: 1, role: `${topic} 조사`, topic, brief, lookup: true, state: 'working', sessionKey: 's', hiredAt: at }
  settleMember(m, { answer: said, sources }, at, true)
  return m
}
const handed = (members: TeamMember[]): { who: string; part?: string; state: string; result: string; sources?: string[] }[] => (JSON.parse(handBacks(members)) as { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[] }).reports

describe('c18a rule 1 (c19a): what a row says reaches the reader whole; no host quote match decides it', () => {
  const ask = '광주 지금 날씨 어때?\n날씨: 기온이나 하늘 상태'
  it('a value row (6.0°C) and rows with figures go to the reader as they are, from one model call', async () => {
    const item = { title: '광주 날씨', text: '광주 날씨 — 현재 6.0°C, 맑음 — 11월 20일' }
    const { jobs, out, found } = await passed(ask, [item, { title: '요금', text: '요금 — 대인 왕복 18,000 원' }, { title: '영업', text: '영업 — 영업시간 09:30~22:00' }])
    expect(jobs).toBe(1)
    expect(out).toBe(found)
    for (const words of ['현재 6.0°C, 맑음', '대인 왕복 18,000 원', '영업시간 09:30~22:00']) expect(out).toContain(words)
  })
  it('a headline-only row is passed on as a row, and kept as read with its title and address only', async () => {
    const { out, found, kept } = await passed(ask, [{ title: '광주 오늘 날씨 총정리', text: '광주 오늘 날씨 총정리' }, { title: '대전 미세먼지 보통', text: '대전 미세먼지 보통 — 초미세먼지 32㎍/㎥ — 11월 20일' }])
    expect(out).toBe(found)
    expect(urls(out)).toEqual(['https://item.example/1', 'https://item.example/2'])
    expect(kept.split('\n')).toEqual(['광주 오늘 날씨 총정리 https://item.example/1', '대전 미세먼지 보통: 초미세먼지 32㎍/㎥, 11월 20일 https://item.example/2'])
  })
  it('kind: a "추진" headline and a real funding report both reach the reader; which is one of the kind is its call', async () => {
    const ask = '요즘 국내 배터리 스타트업 투자 유치 뉴스 6개'
    const { out, found } = await passed(ask, [{ title: '셀볼트, 투자 유치 추진', text: '셀볼트, 투자 유치 추진 — 셀볼트가 이번 주 데모데이에 참가해 사업을 소개했다' }, { title: '셀볼트, 시리즈A 80억 투자 유치', text: '셀볼트, 시리즈A 80억 투자 유치 — 셀볼트가 80억 원 규모 시리즈A 투자를 유치했다' }])
    expect(out).toBe(found)
    expect(out).toContain('셀볼트가 이번 주 데모데이에 참가해 사업을 소개했다')
    expect(out).toContain('셀볼트가 80억 원 규모 시리즈A 투자를 유치했다')
  })
})

describe('c18a rule 4: points from the ask\'s words (대전 내일 미세먼지 어때?)', () => {
  const ask = '대전 내일 미세먼지 어때?'
  const rows = [row('https://air.example/1', '대전 미세먼지 보통', '초미세먼지 32㎍/㎥, 오후 한때 나쁨'), row('https://news.example/2', '대전 대기질 소식', '이번 주 대기 정체')]
  it('the host makes no second search; both rows go to the reader, and the ask is in the one prompt it gets', async () => {
    const s = search([page('q', rows)])
    const out = await looked(ask, [s], [Q], 'x')
    expect(out.jobs).toHaveLength(1)
    expect(out.jobs[0]!.prompt).toContain(ask)
    expect(s.queries).toEqual(['q'])
    expect(urls(out.got[0]!)).toEqual(['https://air.example/1', 'https://news.example/2'])
  })
  it('no points are made of the ask and no later round runs: on the step path there are two model steps, the search and the answer', async () => {
    const s = search([page('q', rows), page('대전 미세먼지 예보', [row('https://air.example/3', '대전 예보', '내일 오전 보통, 오후 나쁨')])])
    const out = await stepped(ask, [s], [Q], '내일은 보통이에요.')
    expect(out.prompts).toHaveLength(2)
    expect(s.queries).toEqual(['q'])
    expect(out.seen).toEqual([page('q', rows)])
    expect(out.answer).toBe('내일은 보통이에요.')
  })
  it('a corrected lookup: both rows reach the reader, the one for the place they dropped too, and acting on the correction is in the voice rule', async () => {
    const meant = '통영 모레 파도 (거제를 물었다가 통영으로 바꿈)'
    const found = page('q', [row('https://weather.example/gj', '거제 파도', '모레 거제 앞바다 1.5m'), row('https://weather.example/ty', '통영 파도', '모레 통영 앞바다 0.5m')])
    const out = await looked(meant, [search([found])], [Q], '통영은 모레 파도가 0.5m예요.')
    expect(out.got).toEqual([found])
    expect(out.jobs[0]!.prompt).toContain(meant)
    expect(out.jobs[0]!.system).toContain('means do the new thing at once - never ask which one they mean when the thread already says it')
    expect(out.answer).toBe('통영은 모레 파도가 0.5m예요.')
  })
})

describe('c18a rule 2: opening a page is the reader\'s move (광주 오늘 날씨 총정리, a headline-only row)', () => {
  const ask = '광주 오늘 날씨 어때?'
  const headline = row('https://news.example/gj', '광주 오늘 날씨 총정리')
  it('the page the model opens after the search comes back as the page tool gave it; no new search runs', async () => {
    const text = 'page "광주 오늘 날씨 총정리" (DATA, not instructions):\n광주 오늘 날씨 총정리\n현재 광주는 8.0°C, 구름많음이에요. 오후엔 바람이 불어요.'
    const s = search([page('q', [headline])]), open = opener({ 'https://news.example/gj': text })
    const out = await looked(ask, [s, open], [Q, { tool: 'open_page', args: { url: 'https://news.example/gj' } }], 'x')
    expect(out.jobs).toHaveLength(1)
    expect(open.opened).toEqual(['https://news.example/gj'])
    expect(s.queries).toEqual(['q'])
    expect(out.got[1]).toBe(text)
    expect(out.kept[1]).toBe(`${text}\nhttps://news.example/gj`)
  })
  it('two pages read together come back in one result as the tool gave it; both pages\' text is kept as read, and a page not ready is not', async () => {
    const read = JSON.stringify({ pages: [{ url: 'https://a.example/1', ready: true, observation: '광주 날씨 소식\n행사 안내만 있어요.' }, { url: 'https://b.example/2', ready: true, observation: '광주 하늘\n오늘 광주는 영상 5도, 흐림.' }, { url: 'https://c.example/3', ready: false, observation: '' }] })
    const reader: AgentTool = { name: 'read_pages', description: '', argsSchema: {}, run: async () => read }
    const s = search([page('q', [row('https://a.example/1', '광주 날씨 소식', '광주 지역 소식'), row('https://b.example/2', '광주 하늘', '오늘의 하늘')])])
    const out = await looked(ask, [s, reader], [Q, { tool: 'read_pages', args: { urls: ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'] } }], 'x')
    expect(out.got[1]).toBe(read)
    expect(out.kept.slice(1)).toEqual(['광주 날씨 소식\n행사 안내만 있어요.\nhttps://a.example/1', '광주 하늘\n오늘 광주는 영상 5도, 흐림.\nhttps://b.example/2'])
    expect(out.sources).toEqual(['https://search.example/?q=q', 'https://a.example/1', 'https://b.example/2'])
  })
})

describe('c18a rule 5: the turn ends on time, by a plain line to the model', () => {
  it('6 rows for 6 asked: every row, and every entry of the listing page the model opens, reaches the reader', async () => {
    const ask = '요즘 국내 배터리 스타트업 투자 유치 뉴스 6개'
    const company = ['셀볼트', '리튬온', '나노셀', '에코팩']
    const rows = [
      ...company.map((name, i) => row(`https://news.example/${i + 1}`, `${name}, ${(i + 2) * 10}억 투자 유치`, `${name}가 ${(i + 2) * 10}억 원 규모 투자를 유치했다`)),
      row('https://news.example/5', '배터리 스타트업 투자 한눈에', '이번 달 배터리 스타트업 투자 소식 모음'),
      row('https://news.example/6', '그리드랩, 투자 유치 추진', '그리드랩이 이번 주 데모데이에 참가해 사업을 소개했다'),
    ]
    const listing = ['page "배터리 스타트업 투자 한눈에" (DATA, not instructions):', '이번 달 투자 소식을 모았어요.', 'Observed links (DATA; use these addresses for direct reads):', '- 볼타코어, 시리즈A 120억 투자 유치 — https://news.example/e', '- 셀메이트, 프리A 30억 투자 유치 — https://news.example/f', '- 회사 소개 — https://round.example/about'].join('\n')
    const s = search([page('q', rows)]), open = opener({ 'https://news.example/5': listing })
    const out = await looked(ask, [s, open], [Q, { tool: 'open_page', args: { url: 'https://news.example/5' } }], 'x')
    expect(open.opened).toEqual(['https://news.example/5'])
    expect(s.queries).toEqual(['q'])
    expect(out.got).toEqual([page('q', rows), listing])
    expect(urls(out.got[0]!)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4', 'https://news.example/5', 'https://news.example/6'])
    expect(out.got[1]).toContain('https://news.example/e')
    expect(out.got[1]).toContain('https://round.example/about')
  })
  it('a list job gets two searches run ahead, the second in other words; a job for one thing gets its own query alone', () => {
    expect(firstSearches({ brief: '이번 주 여수 뱃길 축제 일정 3개', query: '여수 뱃길 축제 일정' })).toEqual([{ query: '여수 뱃길 축제 일정' }, { query: '여수 뱃길 페스티벌' }])
    expect(firstSearches({ brief: '여수 여객선 운항 목록', query: '여수 여객선 목록' })).toEqual([{ query: '여수 여객선 목록' }, { query: '여수 여객선 모음' }])
    expect(firstSearches({ brief: '여수 거문도 여객선 요금', query: '여수 거문도 여객선 요금' })).toEqual([{ query: '여수 거문도 여객선 요금' }])
    expect(firstSearches({ brief: '여수 거문도 여객선 요금' })).toEqual([])
  })
  it('a round that fits (c19a): with a round left the result is untouched; with less it ends on the plain line; with no time for a call the search is not run', async () => {
    const ask = '제천 청풍 케이블카 요금'
    const found = page('q', [row('https://news.example/1', '청풍 케이블카 개장', '관광객 늘어')])
    const run = async (left: number) => {
      const s = search([found])
      const out = await looked(ask, [s], [Q], 'x', () => left)
      return { queries: s.queries, got: out.got }
    }
    expect(await run(LOOKUP_ROUND_MS)).toEqual({ queries: ['q'], got: [found] })
    expect(await run(LOOKUP_ROUND_MS - 1)).toEqual({ queries: ['q'], got: [`${found}\n\n${ANSWER_FROM_THIS}`] })
    expect(await run(LOOKUP_CALL_MS)).toEqual({ queries: ['q'], got: [`${found}\n\n${ANSWER_FROM_THIS}`] })
    expect(await run(LOOKUP_CALL_MS - 1)).toEqual({ queries: [], got: [ANSWER_FROM_THIS] })
  })
  it('"멈춰" while two pages are being read: it returns at once, and nothing more is searched or read', async () => {
    const stop = new AbortController(), ask = '부산 송도 케이블카 요금'
    const s = search([page('q', [row('https://a.example/1', '송도 케이블카', '해상 케이블카 소식'), row('https://b.example/2', '송도 관광', '송도 해수욕장 이야기')])])
    let reads = 0
    const reader: AgentTool = { name: 'read_pages', description: '', argsSchema: {}, run: (_args, context) => {
      reads++
      setTimeout(() => stop.abort(new Error('stopped by the person')), 50)
      return new Promise<string>((_resolve, reject) => context.signal?.addEventListener('abort', () => reject(new Error('stopped by the person')), { once: true }))
    } }
    const started = Date.now()
    await expect(looked(ask, [s, reader], [Q, { tool: 'read_pages', args: { urls: ['https://a.example/1', 'https://b.example/2'] } }, Q], 'x', () => 20_000, stop.signal)).rejects.toThrow('stopped by the person')
    expect(Date.now() - started).toBeLessThan(500)
    expect(reads).toBe(1)
    expect(s.queries).toEqual(['q'])
  })
})

describe('c18a rule 3: a first-hand read is the helper\'s evidence', () => {
  it('(c19a) a fact on a page it read and a fact on a row it was shown both stand as its own cited sentence, never a host label; each part is found', () => {
    const parts = [
      settled('제천', '제천 케이블카 요금', '제천 청풍 케이블카는 어른 왕복 1만 8천 원이에요 [청풍](https://cable.example/jc)', ['https://cable.example/jc', 'https://search.example/?q=x']),
      settled('밀양', '밀양 케이블카 요금', '밀양 얼음골 케이블카는 왕복 1만 6천 원이에요 [검색 결과](https://news.example/my)', ['https://search.example/?q=y']),
      settled('여주', '여주 케이블카 요금', '여주 케이블카는 왕복 1만 5천 원이에요 [여주](https://cable.example/yj)', ['https://cable.example/yj']),
    ]
    expect(handed(parts).map(one => one.result)).toEqual(['제천 청풍 케이블카는 어른 왕복 1만 8천 원이에요 [청풍](https://cable.example/jc)', '밀양 얼음골 케이블카는 왕복 1만 6천 원이에요 [검색 결과](https://news.example/my)', '여주 케이블카는 왕복 1만 5천 원이에요 [여주](https://cable.example/yj)'])
    expect(handed(parts)[0]!.sources).toEqual(['https://cable.example/jc', 'https://search.example/?q=x'])
    expect(parts.map(partOutcome)).toEqual(['found', 'found', 'found'])
    expect(JSON.stringify(handed(parts))).not.toContain('못 찾았어요')
  })
})

describe('c18a r2 #1 (c19a): no host test of units or whole sentences; the rows reach the reader whole', () => {
  it('rows with a percentage and a price, a weight change and a weight, reach the reader as they are', async () => {
    const { jobs, out, found } = await passed('생수 2L 값 얼마야', [{ title: '생수값 소식', text: '생수값 소식 — 생수 2L 값이 3% 올라 1,250원이 됐다' }, { title: '신형 노트북', text: '신형 노트북 — 전작보다 15% 가벼워졌다' }, { title: '신형 노트북', text: '신형 노트북 — 무게 1.2 kg' }, { title: '세종 날씨', text: '세종 날씨 — 오후 흐림' }])
    expect(jobs).toBe(1)
    expect(out).toBe(found)
    for (const words of ['생수 2L 값이 3% 올라 1,250원이 됐다', '전작보다 15% 가벼워졌다', '무게 1.2 kg', '오후 흐림']) expect(out).toContain(words)
  })
  it('a "not done" sentence and a done one reach the reader whole, and are kept whole as read; which is a signing is its call', async () => {
    const { out, kept } = await passed('센터백 영입 소식', [{ title: '수원, 센터백 영입 협상', text: '수원, 센터백 영입 협상 — 수원이 센터백 영입 협상을 진행 중이지만 아직 계약하지 않았다' }, { title: '수원, 센터백 영입', text: '수원, 센터백 영입 — 수원이 센터백 박도현을 영입했다고 2일 밝혔다. 계약 기간은 3년이다' }])
    expect(out).toContain('아직 계약하지 않았다')
    expect(out).toContain('박도현을 영입했다고 2일 밝혔다')
    expect(kept).toContain('수원이 센터백 영입 협상을 진행 중이지만 아직 계약하지 않았다')
    expect(kept).toContain('박도현을 영입했다고 2일 밝혔다. 계약 기간은 3년이다')
  })
  it('the judge is gone; the one result the host swaps is a sign-in wall, for a plain line that sends the reader to another source', async () => {
    for (const gone of ['judgedItems', 'checkedSearch', 'helperParts']) expect(core).not.toHaveProperty(gone)
    const wall = formatAsk('로그인이 필요해요. 직접 로그인해 주실래요?', [])
    const text = 'page "생수 가격표" (DATA, not instructions):\n생수 2L 1,250원'
    const open = opener({ 'https://mall.example/water': wall, 'https://price.example/water': text })
    const out = await looked('생수 2L 값 얼마야', [open], [{ tool: 'open_page', args: { url: 'https://mall.example/water' } }, { tool: 'open_page', args: { url: 'https://price.example/water' } }], 'x')
    expect(out.got[0]).toMatch(/^https:\/\/mall\.example\/water needs the person \(a sign-in, a robot check, or a setting only they have\) and was not read\./)
    expect(out.got[0]).toContain('read another source')
    expect(out.got[1]).toBe(text)
    expect(out.sources).toEqual(['https://price.example/water'])
  })
})

describe('c18a r2 #2 (c19a): a page\'s fact is the helper\'s own sentence; the host adds nothing to it', () => {
  it('a point the helper\'s words leave out is not added; its own sentence keeps the name it gave the page', () => {
    const said = '에어북 무게는 980g이에요. [메이커](https://maker.example/air)'
    const m = settled('에어북', '에어북 무게와 화면 크기', said, ['https://maker.example/air'])
    expect(m.result).toBe(said)
    expect(m.result).not.toContain('화면')
    expect(handed([m])[0]!.result).toContain('[메이커](https://maker.example/air)')
  })
  it('a point the helper\'s words already state is not repeated', () => {
    const said = '에어북 무게는 980g, 화면 크기는 13.6인치예요. [메이커](https://maker.example/air)'
    const m = settled('에어북', '에어북 무게와 화면 크기', said, ['https://maker.example/air'])
    expect(m.result).toBe(said)
    expect(m.result!.match(/화면 크기/g)).toHaveLength(1)
    expect(m.result!.match(/980g/g)).toHaveLength(1)
  })
})

describe('c18a r3 (c19a): no blind read runs; the rows are read once, by the model that answers', () => {
  it('the reviewer\'s price: "4%가량 하락" reaches the reader as the row said it, and the rule keeps a number of its own out', async () => {
    const { out, found } = await passed('주가 얼마야', [{ title: '주가 소식', text: '주가 소식 — 주가는 4%가량 하락했다' }])
    expect(out).toBe(found)
    expect(out).toContain('주가는 4%가량 하락했다')
    expect(LOOKUP_RULE).toContain('A number comes from a result or is a previous model\'s known launch price, labeled as what it is: never a number of your own')
  })
  it('the reviewer\'s kind: the "not yet" funding row reaches the reader whole, in a turn of one model call whose prompt is the ask', async () => {
    const quote = '로봇랩이 투자 유치를 추진 중이며 아직 투자를 받지 못했다', ask = '로봇 회사 자금 소식 세 건'
    const found = page('q', asRows([{ text: `투자 유치 추진 — ${quote}` }]))
    const out = await looked(ask, [search([found])], [Q], '투자를 받았다는 소식은 없었어요.')
    expect(out.jobs).toHaveLength(1)
    expect(out.jobs[0]!.prompt).toContain(ask)
    expect(out.jobs[0]!.prompt).not.toContain('Entries: ')
    expect(out.got[0]).toContain(quote)
    expect(out.answer).toBe('투자를 받았다는 소식은 없었어요.')
  })
  it('new wordings: fares and signings reach the next model step row for row, in two steps and no other prompt', async () => {
    const items = [
      { text: '광역버스 요금 조정 — 광역버스 기본요금이 12% 오른다' },
      { text: '광역버스 요금표 — 광역버스 기본요금은 3,000원이다' },
      { text: '수원, 윙어 영입 근접 — 수원이 윙어 김하람과 협상 중이나 아직 서명하지 않았다' },
      { text: '대전, 윙어 영입 — 대전이 윙어 이도윤을 영입했다고 5일 밝혔다' },
    ]
    const found = page('q', asRows(items))
    const out = await stepped('광역버스 요금 얼마야', [search([found])], [Q], '기본요금은 3,000원이에요.')
    expect(out.prompts).toHaveLength(2)
    for (const item of items) expect(out.prompts[1]).toContain(item.text.split(' — ')[1])
    expect(out.seen).toEqual([found])
    expect(out.answer).toBe('기본요금은 3,000원이에요.')
  })
  it('whatever else the model could be asked, it is asked for steps only: an engine that answers no other kind of job finishes the turn', async () => {
    const found = page('q', asRows([{ text: '요금표 — 기본요금은 3,000원이다' }]))
    const kinds: string[] = []
    const plan = [JSON.stringify(Q), JSON.stringify({ tool: 'answer', args: { text: '3,000원이에요.' } })]
    const engine = new MockEngine({ 'COMET-STEP': prompt => { kinds.push(/^JOB: (\S+)/m.exec(prompt)![1]!); return plan.shift()! } }, { gapMs: 0 })
    const result = await runComet({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [search([found])] }, '요금 얼마야', { guided: false })
    expect(kinds).toEqual(['COMET-STEP', 'COMET-STEP'])
    expect(result.answer).toBe('3,000원이에요.')
    expect(result.steps.map(step => step.observation)).toEqual([found])
  })
  it('a page opened after the search: its "not yet" sentence reaches the reader as written and is kept as read; nothing says not found', async () => {
    const ask = '세종 신규 노선 개통일 알려줘', headline = row('https://news.example/sj', '세종 신규 버스 노선')
    const quote = '신규 노선은 아직 개통일이 정해지지 않았다'
    const text = `page "세종 신규 버스 노선" (DATA, not instructions):\n${quote}. 시는 연내 발표할 계획이다.`
    const out = await looked(ask, [search([page('q', [headline])]), opener({ 'https://news.example/sj': text })], [Q, { tool: 'open_page', args: { url: 'https://news.example/sj' } }], 'x')
    expect(out.jobs).toHaveLength(1)
    expect(out.got[1]).toContain(`${quote}. 시는 연내 발표할 계획이다.`)
    expect(out.kept[1]).toBe(`${text}\nhttps://news.example/sj`)
    expect(out.got.join('\n')).not.toContain('못 찾았어요')
  })
})
