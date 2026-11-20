import { describe, expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runComet } from '../src/agent-session.js'
import { handBacks, partOutcome } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { MockEngine } from '../src/engine/mock.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'
import * as core from '../src/index.js'
import { keepRead, keepSources, LOOKUP_RULE, settleMember, skipWalls, timeBoxed } from '../src/team-hire-tools.js'

const page = (query: string, rows: string[], words = ''): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows, ...(words ? ['', words] : [])].join('\n')
const row = (n: number, title: string, snippet: string, host = 'news.example'): string => `- ${title} — https://${host}/${n} — ${snippet} — 11월 ${n}일`
function search(outs: string[]): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return outs.shift() ?? page(String(args['query']), []) } }
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
const opener = (pages: Record<string, string>): AgentTool & { opened: string[] } => {
  const opened: string[] = []
  return { opened, name: 'open_page', description: '', argsSchema: {}, run: async args => { opened.push(String(args['url'])); return pages[String(args['url'])] ?? 'that did not work: no such page' } }
}
const at = new Date().toISOString()
const settled = (brief: string, said: string, sources: string[] = [], topic = '대상'): TeamMember => {
  const m: TeamMember = { id: 'h', parentId: null, depth: 1, role: '조사', topic, brief, lookup: true, state: 'working', sessionKey: 's', hiredAt: at }
  settleMember(m, { answer: said, sources }, at, true)
  return m
}
const handed = (members: TeamMember[]): { who: string; part?: string; state: string; result: string; sources?: string[] }[] => (JSON.parse(handBacks(members)) as { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[] }).reports

describe('c17a: whether a headline states the value is the reader\'s to tell', () => {
  it('no host test decides it: the row goes to the reader, and the page it opens for it comes back whole and is kept as read', async () => {
    const ask = '광주 모레 공기 질 괜찮아?'
    const found = page('q', ['- 광주 내일 미세먼지 전망 정리 — https://news.example/1 — 광주 지역 미세먼지 관련 소식을 모았습니다 — 11월 18일'])
    const text = 'page "광주 대기질 예보" (DATA, not instructions):\n내일 광주 미세먼지 \'나쁨\', 초미세먼지 38㎍/㎥'
    const open = opener({ 'https://news.example/1': text })
    const out = await looked(ask, [search([found]), open], [Q, { tool: 'open_page', args: { url: 'https://news.example/1' } }], '내일 광주는 미세먼지가 나쁨이에요.')
    expect(out.jobs).toHaveLength(1)
    expect(open.opened).toEqual(['https://news.example/1'])
    expect(out.got).toEqual([found, text])
    expect(out.kept[1]).toBe(`${text}\nhttps://news.example/1`)
    expect(out.sources).toEqual(['https://search.example/?q=q', 'https://news.example/1'])
  })
})

describe('c17a: headline vs value (광주 미세먼지)', () => {
  const ask = '광주 내일 미세먼지 어때?'
  const headline = row(1, '광주 내일 미세먼지 전망 정리', '광주 지역 미세먼지 관련 소식을 모았습니다')
  const value = row(2, '광주 대기질 예보', "내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥", 'air.example')
  it('both rows reach the reader, the headline one and the one with the value, with no host quote line', async () => {
    const s = search([page('q', [headline, value])])
    const out = await looked(ask, [s], [Q], 'x')
    expect(s.queries).toEqual(['q'])
    expect(out.got).toEqual([page('q', [headline, value])])
    expect(urls(out.got[0]!)).toEqual(['https://news.example/1', 'https://air.example/2'])
    expect(out.got[0]).not.toContain('· 미세먼지 등급:')
  })

  it('only the headline: the page the model reads for it comes back as the reading tool gave it, and its words are kept for the hand-back', async () => {
    const read = JSON.stringify({ pages: [{ url: 'https://news.example/1', ready: true, observation: "광주 내일 미세먼지 전망 정리\n기상청에 따르면 광주는 내일 미세먼지 '나쁨' 수준이 예상돼요." }] })
    const reader: AgentTool = { name: 'read_pages', description: '', argsSchema: {}, run: async () => read }
    const out = await looked(ask, [search([page('q', [headline])]), reader], [Q, { tool: 'read_pages', args: { urls: ['https://news.example/1'] } }], 'x')
    expect(out.got[1]).toBe(read)
    expect(out.kept[1]).toBe("광주 내일 미세먼지 전망 정리\n기상청에 따르면 광주는 내일 미세먼지 '나쁨' 수준이 예상돼요.\nhttps://news.example/1")
    expect(out.sources).toContain('https://news.example/1')
    expect(out.jobs).toHaveLength(1)
  })

  it('only the headline, no page reader: the host runs no second search; the row goes to the reader, and when to open a page is in its rule', async () => {
    const s = search([page('q', [headline]), page('광주 미세먼지 예보 등급', [value])])
    const out = await looked(ask, [s], [Q], 'x')
    expect(s.queries).toEqual(['q'])
    expect(urls(out.got[0]!)).toEqual(['https://news.example/1'])
    expect(LOOKUP_RULE).toContain('open a page only for a number none of them shows')
  })

  it('"멈춰" while a page is opening returns at once; nothing more is searched or opened', async () => {
    const stop = new AbortController(), s = search([page('q', [headline])])
    const opened: string[] = []
    const open: AgentTool = { name: 'open_page', description: '', argsSchema: {}, run: (args, context) => {
      opened.push(String(args['url']))
      setTimeout(() => stop.abort(new Error('stopped by the person')), 50)
      return new Promise<string>((_resolve, reject) => context.signal?.addEventListener('abort', () => reject(new Error('stopped by the person')), { once: true }))
    } }
    const started = Date.now()
    await expect(looked(ask, [s, open], [Q, { tool: 'open_page', args: { url: 'https://news.example/1' } }, Q, { tool: 'open_page', args: { url: 'https://air.example/2' } }], 'x', () => 20_000, stop.signal)).rejects.toThrow('stopped by the person')
    expect(Date.now() - started).toBeLessThan(500)
    expect(opened).toEqual(['https://news.example/1'])
    expect(s.queries).toEqual(['q'])
  })
})

describe('c17a: kind (바이오 인수합병 4개)', () => {
  const ask = '요즘 국내 바이오 스타트업 인수합병 뉴스 4개'
  const rows = [
    row(1, '바이오젠코리아, 셀메드 인수', '바이오젠코리아가 세포치료 스타트업 셀메드를 인수했다'),
    row(2, '바이오 M&A 컨퍼런스 개최', '국내 바이오 인수합병 전략을 논의하는 컨퍼런스가 열린다'),
    row(3, '진랩, 엔자임원 합병 완료', '유전체 분석 기업 진랩이 엔자임원과의 합병을 마쳤다'),
    row(4, '바이오 전용 펀드 1천억 출범', '바이오 스타트업에 투자하는 펀드가 출범했다'),
    row(5, '메디큐브, 뉴로스타 지분 100% 인수', '디지털 치료제 스타트업 뉴로스타 지분 100%를 인수했다'),
  ]
  it('5 rows for 4 asked: no further search; every row is in what the next model step reads, which lists only what is of the kind', async () => {
    const s = search([page('q', rows), page('바이오 스타트업 피인수', [row(6, '바이오 업계 동향', '올해 바이오 투자 시장 분위기')])])
    const out = await stepped(ask, [s], [Q], '세 건이 인수합병 소식이에요.')
    expect(s.queries).toEqual(['q'])
    expect(out.seen).toEqual([page('q', rows)])
    for (const line of rows) expect(out.prompts[1]).toContain(line.slice(2))
    expect(out.prompts[1]).not.toMatch(/of these rows are from the period asked|asked for were found/)
    expect(out.answer).toBe('세 건이 인수합병 소식이에요.')
  })
})

describe('c17a: two points (맥북 에어 M6 가격이랑 출시일)', () => {
  const ask = '맥북 에어 M6 가격이랑 출시일'
  it('a price row and no date: no host "not found"; the helper\'s own sentences are what the lead is handed', async () => {
    const found = page('q', [row(1, '맥북 에어 M6 국내 가격', '맥북 에어 M6는 179만 원부터 시작한다', 'apple.example')])
    const said = '맥북 에어 M6는 179만 원부터예요 [애플](https://apple.example/1). 출시일은 아직 안 나왔어요.'
    const out = await looked(ask, [search([found])], [Q], said)
    expect(out.got).toEqual([found])
    expect(out.answer).toBe(said)
    const own = settled(ask, out.answer, out.sources, '맥북 에어 M6')
    expect(own.result).toBe(said)
    expect(own.result!.match(/출시일/g)).toHaveLength(1)
    expect(own.data).toBeUndefined()
    const galaxy = settled('갤럭시북 6 값과 나오는 날', '갤럭시북 6는 159만 원이고 3월 6일 나와요. [삼성](https://samsung.example/1)', ['https://samsung.example/1'], '갤럭시북 6')
    expect(handed([own, galaxy]).map(one => [one.part, one.result])).toEqual([['맥북 에어 M6', said], ['갤럭시북 6', '갤럭시북 6는 159만 원이고 3월 6일 나와요. [삼성](https://samsung.example/1)']])
    expect(JSON.stringify(handed([own, galaxy]))).not.toContain('못 찾았어요')
    for (const gone of ['helperParts', 'mergedReport', 'checkedLead']) expect(core).not.toHaveProperty(gone)
  })
})

describe('c17a r2 (c19a): a helper\'s words stand, links and all', () => {
  const brief = '수원 이번 주말 꽃가루 농도 어때?'
  it('cited prose keeps its words and its link whatever page it names; the part is found, never "못 찾았어요"', () => {
    const said = '수원은 주말 꽃가루가 낮음이에요. [블로그](https://blog.example/7)'
    const m = settled(brief, said, ['https://search.example/?q=pollen'])
    expect(m.result).toBe(said)
    expect(partOutcome(m)).toBe('found')
    expect(handed([m])[0]!.result).toContain('낮음')
    expect(handed([m])[0]!.result).not.toContain('못 찾았어요')
  })
  it('of two cited facts, each stays as the helper wrote it with its own link (a trailing slash aside); nothing is labelled missing', () => {
    const said = '수원은 주말 꽃가루 \'보통\'이에요 [기상청](https://weather.example/pollen/). 일요일엔 비 소식이 있어요 [카페](https://cafe.example/3).'
    const m = settled(brief, said, ['https://weather.example/pollen'])
    expect(m.result).toBe(said)
    expect(m.result).toContain('(https://weather.example/pollen/)')
    expect(m.result).toContain('(https://cafe.example/3)')
    expect(handed([m])[0]!.sources).toEqual(['https://weather.example/pollen'])
  })
  it('a page the helper opened and read itself is handed on as its source, ahead of the results page', () => {
    const said = '수원은 주말 꽃가루 \'높음\'이에요 [기상청](https://weather.example/pollen). 토요일이 제일 심해요 [뉴스](https://news.example/9).'
    const m = settled(brief, said, ['https://search.example/?q=x', 'https://weather.example/pollen'])
    expect(m.sources).toEqual(['https://weather.example/pollen', 'https://search.example/?q=x'])
    expect(m.result).toContain('토요일이 제일 심해요')
    expect(m.result).toBe(said)
  })
  it('a helper with no record of what it read keeps its cited words as before, and is handed back without a sources list', () => {
    const said = '수원은 주말 꽃가루가 낮음이에요. [블로그](https://blog.example/7)'
    const m = settled(brief, said)
    expect(m.result).toBe(said)
    expect(handed([m])[0]).toEqual({ who: '조사', part: '대상', state: 'done', result: said })
  })
})

describe('c17a r2: a counted ask with several points', () => {
  const ask = '아이패드 미니 8이랑 갤럭시 탭 S12 무게랑 배터리 용량 비교해줘'
  it('two rows for two asked: the host searches no further and adds no "not found" line; both rows go to the reader', async () => {
    const first = page('q', [row(1, '아이패드 미니 8 무게', '아이패드 미니 8은 293g이다', 'apple.example'), row(2, '갤럭시 탭 S12 무게', '갤럭시 탭 S12는 498g이다', 'samsung.example')])
    const s = search([first, page('태블릿 배터리 용량', [row(3, '태블릿 신제품 소식', '여러 태블릿이 곧 나온다')])])
    const out = await looked(ask, [s], [Q], 'x')
    expect(s.queries).toEqual(['q'])
    expect(out.got).toEqual([first])
    expect(out.got[0]).not.toContain('not found in anything read')
  })
  it('rows that state every point end it in one round: one search, one model call, and the draft is the answer', async () => {
    const first = page('q', [row(1, '아이패드 미니 8', '293g, 배터리 5,078mAh', 'apple.example'), row(2, '갤럭시 탭 S12', '498g, 배터리 8,400mAh', 'samsung.example')])
    const s = search([first])
    const draft = '미니 8은 293g에 5,078mAh, 탭 S12는 498g에 8,400mAh예요.'
    const out = await looked(ask, [s], [Q], draft)
    expect(s.queries).toEqual(['q'])
    expect(out.jobs).toHaveLength(1)
    expect(urls(out.got[0]!)).toEqual(['https://apple.example/1', 'https://samsung.example/2'])
    expect(out.answer).toBe(draft)
  })
})

describe('c17a r3 (c19a): a helper\'s part is its own sentences; the host relabels nothing', () => {
  it('both values a helper cited to a page stand, with no host label', () => {
    const m = settled('라이트북 무게와 배터리 알려줘', '라이트북은 1.2kg이고 배터리는 90Wh예요. [제품](https://example.com/p)', ['https://example.com/p'])
    expect(m.result).toContain('90Wh')
    expect(m.result).toContain('1.2kg')
    expect(m.result).not.toContain('못 찾았어요')
    expect(m.state).toBe('done')
  })
  it('the helper\'s whole sentence stands as it wrote it', () => {
    const said = '제주 렌터카는 하루 4만 2천 원, 보험은 1만 5천 원이에요 [업체](https://rent.example/jeju)'
    const m = settled('제주 렌터카 하루 요금이랑 보험료', said, ['https://rent.example/jeju'])
    expect(m.result).toBe(said)
    expect(m.said).toBe(said)
  })
  it('prose cited to a page other than the results page stays as written; the part is found, never said not found', () => {
    const said = '수원 꽃가루는 낮음이에요. [기사](https://example.com/a)'
    const m = settled('수원 이번 주말 꽃가루 농도 알려줘', said, ['https://search.example/?q=pollen'])
    expect(m.result).toBe(said)
    expect(partOutcome(m)).toBe('found')
    expect(m.empty).toBeUndefined()
  })
  it('on a page it read whole itself, its prose stands and that page is its one source', () => {
    const said = '해운대 수온은 22도예요 [해양청](https://sea.example/busan). 파고는 1.5m예요 [해양청](https://sea.example/busan)'
    const m = settled('부산 해수욕장 수온이랑 파고', said, ['https://sea.example/busan', 'https://sea.example/busan'])
    expect(m.result).toBe(said)
    expect(m.sources).toEqual(['https://sea.example/busan'])
  })
  it('a point the helper did not state is not added by the host as not found', () => {
    const said = '해운대 수온은 22도예요 [해양청](https://sea.example/busan)'
    const m = settled('부산 해수욕장 수온이랑 파고', said, ['https://sea.example/busan'])
    expect(m.result).toBe(said)
    expect(handed([m])[0]!.result).toBe(said)
  })
})
