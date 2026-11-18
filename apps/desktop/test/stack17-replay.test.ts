import { describe, expect, it, vi } from 'vitest'
import { checkedSearch, createBot, handoffBrief, helperParts, initVault, loadBots, mergedReport, recordFacts, reportData, settleMember, staffTool, TEAM_MEMORY, teamSummary, writtenReport, type AgentTool, type Proof, type TeamMember } from 'core'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { askNow, checkedDesk } from '../src/main/desk-lane.js'
import { tmpVaultRoot } from '../../../packages/core/test/helpers.js'
import { agreeing } from '../../../packages/core/test/agreeing.js'

const page = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const row = (url: string, title: string, snippet: string, day = '11월 18일'): string => `- ${title} — ${url} — ${snippet} — ${day}`
function search(outs: string[]): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return outs.shift() ?? page(String(args['query']), []) } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)

describe('R1 (stack16: 서울 cell was the headline "서울 11월 18일 오늘 날씨 요약")', () => {
  const ask = '서울 오늘 날씨'
  const headline = row('https://news.example/joseilbo', '서울 11월 18일 오늘 날씨 요약', '조세일보 날씨 요약 기사')
  const weather = row('https://weather.example/seoul', '서울 날씨', '서울 현재 기온 6.1도, 흐림, 오후 한때 비')
  it('headline + a weather row with a temperature: only the second holds and is shown', async () => {
    const s = search([page('q', [headline, weather])])
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, write: agreeing(async () => JSON.stringify({ keep: [1, 2], asked: 1, search: '', points: ['오늘 기온이나 하늘 상태'], holds: { 1: { '오늘 기온이나 하늘 상태': '서울 11월 18일 오늘 날씨 요약' }, 2: { '오늘 기온이나 하늘 상태': '서울 현재 기온 6.1도, 흐림' } } })) }).run({ query: 'q' }, { task: ask })
    console.log(`R1 replay (both rows):\n${out}`)
    expect(urls(out)).toEqual(['https://weather.example/seoul'])
    expect(out).not.toContain('joseilbo')
  })
  it('the headline alone: the host opens the page (a reader) or searches again (none); the headline is never the answer', async () => {
    const quotedHeadline = JSON.stringify({ keep: [1], asked: 1, search: '서울 현재 기온', open: 1, points: ['오늘 기온이나 하늘 상태'], holds: { 1: { '오늘 기온이나 하늘 상태': '서울 11월 18일 오늘 날씨 요약' } } })
    const opened: string[] = []
    const withReader = await checkedSearch(search([page('q', [headline])]), { ask: () => ask, since: 0, now: () => 0, write: agreeing((() => { const v = [quotedHeadline, JSON.stringify({ keep: [], asked: 1, search: '', holds: { 2: { '오늘 기온이나 하늘 상태': '낮 최고 9도, 맑음' } } })]; return async () => v.shift() })()),
      read: async url => { opened.push(url); return '서울 11월 18일 오늘 날씨 요약\n오늘 서울은 낮 최고 9도, 맑음이에요.' } }).run({ query: 'q' }, { task: ask })
    const s = search([page('q', [headline]), page('서울 현재 기온', [weather])])
    const noReader = await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, write: agreeing((() => { const v = [quotedHeadline, JSON.stringify({ keep: [2], asked: 1, search: '', holds: { 2: { '오늘 기온이나 하늘 상태': '서울 현재 기온 6.1도, 흐림' } } })]; return async () => v.shift() })()) }).run({ query: 'q' }, { task: ask })
    console.log(`R1 replay (headline alone): opened ${opened.join(', ')}\n${withReader}\n--- no reader, searches: ${s.queries.join(' | ')}\n${noReader}`)
    expect(opened).toEqual(['https://news.example/joseilbo'])
    expect(withReader).toContain('낮 최고 9도, 맑음')
    expect(s.queries).toEqual(['q', '서울 현재 기온'])
    expect(urls(noReader)).toEqual(['https://weather.example/seoul'])
  })
})

describe('R3 (stack16: 7 kept, the loop stopped on keep with 14.6 s left, two off-kind items listed)', () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 찾아줘'
  const kind = '국내 AI 스타트업이 투자를 받았다는 보도'
  const rows = [
    row('https://news.example/1', '업스테이지, 1천억 투자 유치', '업스테이지가 시리즈C 투자를 유치했다'),
    row('https://news.example/2', '펨테크 스타트업 7곳 실리콘밸리 IR', '국내 펨테크 스타트업 7곳이 실리콘밸리에서 IR을 열었다'),
    row('https://news.example/3', '리벨리온, 프리IPO 투자 유치', '리벨리온이 프리IPO 투자를 받았다'),
    row('https://news.example/4', 'KB금융 싱가포르 데모데이', 'KB금융이 싱가포르에서 스타트업 데모데이를 열었다'),
    row('https://news.example/5', '트웰브랩스 시리즈B 투자', '트웰브랩스가 시리즈B 투자를 마무리했다'),
    row('https://news.example/6', 'AI 투자 시장 분위기', '올해 AI 투자 시장이 커졌다'),
    row('https://news.example/7', '뤼튼, 투자 유치 완료', '뤼튼이 신규 투자 유치를 완료했다'),
  ]
  it('4 of 7 kept rows have a verified kind quote: the loop goes on while time is left; at the due 4 items and one line that one more was not found', async () => {
    const s = search([page('q', rows), page('AI 스타트업 시리즈 투자 유치', [row('https://news.example/8', 'AI 행사 일정', '이번 주 AI 행사 모음')])])
    const verdicts = [
      JSON.stringify({ keep: [1, 2, 3, 4, 5, 6, 7], asked: 5, kind, search: 'AI 스타트업 시리즈 투자 유치', holds: { 1: { kind: '업스테이지가 시리즈C 투자를 유치했다' }, 3: { kind: '리벨리온이 프리IPO 투자를 받았다' }, 5: { kind: '트웰브랩스가 시리즈B 투자를 마무리했다' }, 7: { kind: '뤼튼이 신규 투자 유치를 완료했다' } } }),
      JSON.stringify({ keep: [8], asked: 5, search: '', holds: {} }),
    ]
    let t = 0
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => { t += 4000; return verdicts.shift() }), since: 0, now: () => t }).run({ query: 'q' }, { task: ask })
    console.log(`R3 replay: searches ${s.queries.join(' | ')}\n${out}`)
    expect(s.queries).toEqual(['q', 'AI 스타트업 시리즈 투자 유치', kind])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/3', 'https://news.example/5', 'https://news.example/7'])
    expect(out).toContain('4 of the 5 asked for were found')
    expect(out).not.toContain('펨테크')
    expect(out).not.toContain('데모데이')
  })
})

describe('R2 (stack16: prices only, 출시일 never looked for)', () => {
  it('a part with a price quote and no date: a date search runs; at the due the row says the date was not found', async () => {
    const ask = '갤럭시 S27 가격이랑 출시일'
    const s = search([page('q', [row('https://samsung.example/s27', '갤럭시 S27 가격', '갤럭시 S27 기본 모델 출고가 125만 4천 원')]), page('갤럭시 S27 출시일', [row('https://blog.example/rumor', '삼성 신제품 루머', '내년 초 여러 제품 전망')])])
    const verdicts = [JSON.stringify({ keep: [1], asked: 1, points: ['가격: 기본 모델 국내 출고가', '출시일'], search: '갤럭시 S27 출시일', holds: { 1: { '가격: 기본 모델 국내 출고가': '기본 모델 출고가 125만 4천 원' } } }), JSON.stringify({ keep: [], asked: 1, search: '', holds: {} })]
    let t = 0, found: { proof: Proof[]; missing: string[] } | undefined
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => { t += 8000; return verdicts.shift() }), since: 0, now: () => t, proved: (proof, missing) => { found = { proof, missing } } }).run({ query: 'q' }, { task: ask })
    const [part] = helperParts([{ id: 'h', parentId: null, depth: 1, role: '갤럭시 조사', topic: '갤럭시 S27', brief: ask, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: new Date().toISOString(), result: 'x', said: '', proof: found!.proof, missing: found!.missing }])
    const table = mergedReport([part!], new Map(), [], true)
    console.log(`R2 replay: searches ${s.queries.join(' | ')}\n${out}\n--- the row:\n${table}`)
    expect(s.queries).toEqual(['q', '갤럭시 S27 출시일'])
    expect(found!.missing).toEqual(['출시일'])
    expect(table).toContain('125만 4천 원')
    expect(table).toContain('출시일은 못 찾았어요')
  })
})

describe('H2 (stack16: the November turn was rewritten back to December)', () => {
  const history = [{ role: 'user', text: 'fixtures/sales.csv에서 12월 매출 합계 알려줘' }, { role: 'assistant', text: '12월 매출 합계는 2,916,000원이에요.' }]
  it('the check\'s ask carries 11월 as the later word; a November draft is not rewritten', async () => {
    const meant = askNow('아 그거 말고 11월 걸로', history), prompts: string[] = []
    const quick = async (prompt: string): Promise<string> => {
      prompts.push(prompt)
      const asked = /The person asked: (.*)/.exec(prompt)![1]!, later = /changed it: \\"([^\\]*)\\"/.exec(asked)?.[1] ?? asked
      const month = /(\d+)월/.exec(later)?.[1] ?? /(\d+)월/.exec(asked)![1]!, draft = /Message: (.*)/.exec(prompt)![1]!
      return /(\d+)월/.exec(draft)![1] === month ? '{"problems":[]}' : JSON.stringify({ problems: [{ kind: 'contradicts', quote: draft, why: '다른 달' }] })
    }
    const draft = '11월 매출 합계는 2,764,000원이에요.'
    const out = await checkedDesk({ ask: meant, draft, source: 'month,amount\n11,2764000\n12,2916000', fromSource: true, quick, since: Date.now() })
    console.log(`H2 replay: meaning = ${meant}\nanswer = ${out}`)
    expect(meant).toContain('"아 그거 말고 11월 걸로"')
    expect(meant).toContain('the later words hold')
    expect(out).toBe(draft)
    expect(prompts).toHaveLength(1)
  })
})

describe('C10 (stack16: "신기능 세 곳", no 노션·슬랙·리니어)', () => {
  it('the stack16 record: the folded draft is refused and the repair (or the host fallback) names 노션, 슬랙, 리니어', async () => {
    const paths = await initVault(await tmpVaultRoot('s17-c10'), { git: false })
    await createBot(paths, { name: '엔그램' })
    await staffTool(paths, () => undefined).run({ add: [{ name: '지민', role: '리서치 담당' }, { name: '서연', role: '카피 담당' }, { name: '도윤', role: '리서치 담당' }] }, { task: '' })
    await recordFacts(paths, TEAM_MEMORY, [
      '노션 신기능 조사 → 이번 주엔 새로 나온 게 없어요 (지민, 2026-11-18)',
      '슬랙 신기능 조사 → 이번 주엔 새로 나온 게 없어요 (서연, 2026-11-18)',
      '리니어 신기능 조사 → 이번 주엔 새로 나온 게 없어요 (도윤, 2026-11-18)',
      '다음 달 서울 IT 행사 일정 정리 → 3건 (지민, 2026-11-18)',
      '홍보 문구 3개 (지민한테 받아서) → 1. 12월 서울 IT 행사, 놓치지 마세요 (서연, 2026-11-18)',
    ], new Date('2026-11-18T02:00:00.000Z'))
    const folded = '이번 주엔 도윤, 지민, 서연이 신기능 세 곳을 조사했는데 새로 나온 게 없었어요. 지민이 서울 IT 행사 일정을 정리했고, 서연이 그걸로 홍보 문구를 썼어요.'
    const bots = await loadBots(paths), now = new Date(2026, 10, 18, 15)
    const calls: string[] = []
    const out = await teamSummary(paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: agreeing(async prompt => { calls.push(prompt); return prompt.includes('Judge meaning only') ? '{"problems":[]}' : folded }) })
    console.log(`C10 replay (draft refused twice → host fallback):\n${out}`)
    expect(calls[1]).toContain('노션 신기능')
    for (const name of ['노션', '슬랙', '리니어']) expect(out).toContain(name)
    expect(out).not.toContain('세 곳')
  })
})

describe('C6 (stack16: "(서연, 지민이 찾은 서울 IT 행사 일정) 코엑스(링크) · 지디넷코리아(링크)")', () => {
  it('the hand-off: no "(서연, …)" tag; the items, an attribution sentence and the giver\'s source line', async () => {
    const block = (report: Record<string, unknown>): string => `\`\`\`report\n${JSON.stringify(report)}\n\`\`\``
    const settled = (m: TeamMember, report: Record<string, unknown>): TeamMember => { const one = { ...m }, answer = block(report); settleMember(one, { answer, report: reportData(answer, one, [], true) ?? null }, new Date().toISOString(), true); return one }
    const at = new Date().toISOString(), COEX = 'https://coex.example/softwave', ZDNET = 'https://zdnet.example/acc'
    const jimin = settled({ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '다음 달 서울 IT 행사 일정 정리', topic: '서울 IT 행사 일정', botId: 'bot-m1', lookup: true, background: true, state: 'done', sessionKey: 's1', hiredAt: at, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개 뽑기' } }, { facts: [{ text: '소프트웨이브 2026은 12월 2일부터 4일까지 코엑스에서 열려요.', url: COEX }, { text: 'ACC 2026이 12월에 서울에서 열려요.', url: ZDNET }] })
    const seoyeon = settled({ id: 'm2', parentId: null, depth: 1, role: '서연', brief: handoffBrief('홍보 문구 3개 뽑기', '지민', jimin.result!, jimin.brief), botId: 'bot-m2', writer: true, background: true, state: 'done', sessionKey: 's2', hiredAt: at }, { items: ['12월 코엑스, 소프트웨이브에서 만나요', '서울 IT 행사, 한 달 미리 챙기세요', 'ACC 2026, 올해 마지막 기술 축제'] })
    const out = await writtenReport({ ask: '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', members: [jimin, seoyeon], write: agreeing(async () => JSON.stringify({ message: '서연이 문구를 써 봤어요.\n\n1. 12월 코엑스', kept: [] })) })
    console.log(`C6 replay:\n${out}`)
    expect(out).not.toMatch(/\(서연|\(지민/)
    expect(out.split('\n')[0]).toBe('1. 12월 코엑스, 소프트웨이브에서 만나요')
    expect(out).toMatch(/서연이 지민이 찾은 .*로 만든 거예요\./)
    expect(out).toContain(COEX)
  })
})
