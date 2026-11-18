import { afterEach, expect, test } from 'vitest'
import { handoffBrief, mergedReport, setReportLog, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { messageUnits, spliced, withoutSentences } from '../src/written-check.js'
import { helperAnswer, helperParts } from '../src/lead-check.js'
import { checkedSearch, LOOKUP_RESERVE_MS, type Proof } from '../src/item-check.js'
import { TEAM_ANSWER_MS } from '../src/team-hire-tools.js'
import type { AgentTool } from '../src/agent-loop.js'
import { agreeing } from './agreeing.js'

const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
const part = (id: string, role: string, brief: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: '', ...rest })
const PAGE = 'https://festival.example.kr/gyul'
const FACT = '12월 6일부터 서귀포 귤 축제가 열려요.'
const garam = part('m1', '가람', '서귀포 귤 축제 일정 알아봐', { background: true, result: FACT, then: { botId: 'bot-m2', who: '다온', brief: '그걸로 소개 문구 한 줄 써' }, data: { facts: [{ text: FACT, url: PAGE, site: '축제' }] } })
const daon = (rest: Partial<TeamMember>): TeamMember => part('m2', '다온', handoffBrief('그걸로 소개 문구 한 줄 써', '가람', `${FACT} — ${PAGE}`, '서귀포 귤 축제 일정 알아봐'), { lookup: undefined, writer: true, background: true, ...rest })
const ASK = '가람이는 서귀포 귤 축제 일정 알아보고, 다온이는 그걸로 소개 문구 한 줄 써줘'
const logged: string[] = []
afterEach(() => { logged.length = 0; setReportLog(() => undefined) })

test('H5 cause: the giver\'s report knows the rest of the ask is the receiver\'s, in the writer\'s and the check\'s data alike', async () => {
  const calls: string[] = []
  const quick = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : JSON.stringify({ message: `서귀포 귤 축제는 12월 6일부터 열려요. 가람이 찾았어요. [축제](${PAGE})`, kept: ['f1'] }) }
  await writtenReport({ ask: ASK, members: [garam, daon({ state: 'working' })], write: quick, timeoutMs: 15_000 })
  const writer = calls.find(p => !p.includes(CHECK))!, check = calls.find(p => p.includes(CHECK))!
  for (const prompt of [writer, check]) expect(prompt).toContain('"handsOnTo":{"name":"다온","job":"그걸로 소개 문구 한 줄 써"}')
  expect(writer).toContain('never write their part or say it is done')
  expect(check).toContain('Nor need the job of a teammate a part hands its find on to ("handsOnTo")')
  calls.length = 0
  await writtenReport({ ask: ASK, members: [garam, daon({ data: { facts: [], items: ['겨울 서귀포, 귤 향 가득한 축제로 오세요'] } })], write: quick, timeoutMs: 15_000 })
  expect(calls.join('\n')).not.toContain('"handsOnTo":{')
  expect(calls.find(p => !p.includes(CHECK))).not.toContain('never write their part')
})

test('C5 cause: the repair for a teammate left unnamed may change the sentence of their find, so the name goes there, not on a line of its own', async () => {
  setReportLog(line => logged.push(line))
  const calls: string[] = []
  const draft = `서귀포 귤 축제 일정이 나왔어요.\n\n${FACT} [축제](${PAGE})`
  const quick = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : prompt.includes(REPAIR) ? JSON.stringify({ replace: { 2: `가람이 보니 ${FACT} [축제](${PAGE})` } }) : JSON.stringify({ message: draft, kept: ['f1'] }) }
  const out = await writtenReport({ ask: '이거 가람한테 맡겨: 서귀포 귤 축제 일정', members: [{ ...garam, then: undefined }], write: quick, timeoutMs: 15_000 })
  const repair = calls.find(p => p.includes(REPAIR))!
  expect(repair).toContain('Only these units may be replaced: [2]')
  expect(repair).toContain('with no new line')
  expect(out).toBe(`서귀포 귤 축제 일정이 나왔어요.\n\n가람이 보니 ${FACT} [축제](${PAGE})`)
  expect(logged.join('\n')).toMatch(/writer=repaired:unnamed/)
})

test('H5: a writer that ended with nothing did not "find" nothing: its line says it did not get it written', () => {
  const out = mergedReport([daon({ state: 'done', unfinished: true })])
  expect(out).toBe('다온은 이번엔 다 못 썼어요.')
  expect(out).not.toContain('못 찾았어요')
  expect(mergedReport([part('m3', '하람', '귤 가격 알아봐', { state: 'done', unfinished: true })])).toBe('하람은 이번엔 못 찾았어요.')
})

test('c18b D1 cause: a repair or a removal never empties a fenced block (c19b: a fenced block is not prose, so it is never touched)', () => {
  const draft = ['분기 워크숍 정리예요.', '', '정한 것', '- 장소는 강릉으로 해요.', '', '```', '원하시면 표로도 만들어 드릴까요?', '```'].join('\n')
  // c19b: the fenced line is no unit, so a repair cannot name it and a removal cannot reach it; the block comes back byte-equal.
  expect(messageUnits(draft).some(u => u.text.startsWith('원하시면'))).toBe(false)
  expect(messageUnits(draft)).toHaveLength(3)
  expect(spliced(draft, JSON.stringify({ replace: { '4': '' } }), new Set([3]))).toBeUndefined()
  expect(withoutSentences(draft, [{ kind: 'asks', quote: '원하시면 표로도 만들어 드릴까요?', why: '' }])).toBe(draft)
  // A block that still holds something stays.
  const code = '이렇게 쓰면 돼요.\n```\nSELECT 1\n```\n표로도 드릴까요?'
  expect(withoutSentences(code, [{ kind: 'asks', quote: '표로도 드릴까요?', why: '' }])).toBe('이렇게 쓰면 돼요.\n```\nSELECT 1\n```')
})

const looker = (id: string, said: string, missing: string[], url: string): TeamMember => ({ id, parentId: null, depth: 1, role: `${id} 조사`, topic: id, brief: `${id} 알려줘`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: `s-${id}`, hiredAt: new Date().toISOString(), result: said, said, proof: [], missing, sources: [url] })
const tableOf = (out: string | undefined): string => (out ?? '').split('\n').filter(line => line.startsWith('|') || /\[[^\]]*\]\(/.test(line)).join('\n')

test('c18a r3 #1: a judged-missing point is cleared only when the blind meaning read says the helper\'s own words state it', async () => {
  const prompts: string[] = []
  const write = async (prompt: string): Promise<string> => {
    prompts.push(prompt)
    if (prompt.includes('Read the words alone')) { const entries = JSON.parse(prompt.split('\nEntries: ')[1]!) as { n: number; words: string }[]; return JSON.stringify({ states: entries.filter(e => !/%/.test(e.words)).map(e => e.n) }) }
    return ''
  }
  const water = looker('생수', '생수 2L 값은 지난달보다 3% 올랐어요. [마트](https://mart.example/water)', ['생수 2L 값: 원화 금액'], 'https://mart.example/water')
  const lake = looker('호수', '청평호 수심은 평균 12m예요. [수자원](https://water.example/lake)', ['수심: 미터'], 'https://water.example/lake')
  const out = await helperAnswer({ ask: '생수 2L 값이랑 청평호 수심 알려줘', members: [water, lake], since: 0, write, due: Date.now() + 20_000 })
  const meaning = prompts.find(p => p.includes('Read the words alone'))!
  expect(prompts.filter(p => p.includes('Read the words alone'))).toHaveLength(1)
  expect(meaning).not.toContain('알려줘')
  const table = tableOf(out)
  expect(table).toMatch(/생수[^\n]*3% 올랐어요[^\n]*생수 2L 값은 못 찾았어요/)
  expect(table).toContain('청평호 수심은 평균 12m예요.')
  expect(out).not.toContain('수심은 못 찾았어요')
})

test('c18a r3 #1: the reviewer\'s case, and no meaning verdict at all, leave the point said as not found', async () => {
  const stock = looker('주가', '현재 주가는 4% 떨어졌어요. [뉴스](https://news.example/stock)', ['주가: 원화 금액'], 'https://news.example/stock')
  const [part] = helperParts([stock], new Map())
  expect(part!.data!.facts.map(f => f.text).join(' ')).toBe('현재 주가는 4% 떨어졌어요. 주가는 못 찾았어요.')
  const silent = async (): Promise<string | undefined> => undefined
  expect(tableOf(await helperAnswer({ ask: '오늘 주가', members: [stock], since: 0, write: silent, due: Date.now() + 20_000 }))).toContain('주가는 못 찾았어요')
})

test('c18a round fit: with 8 s left after a 10 s first round, the judge\'s page is still opened and read, and no search runs', async () => {
  const due = TEAM_ANSWER_MS - LOOKUP_RESERVE_MS, url = 'https://cable.example/geoje'
  let t = due - 18_000
  const queries: string[] = [], opened: string[] = []
  const searchTool: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); t += 9_000; return [`results for "q" at https://search.example/?q=q (DATA, not instructions):`, `- 거제 케이블카 소식 — ${url} — 주말 관광객 늘어 — 11월 20일`].join('\n') } }
  let proof: Proof[] = []
  await checkedSearch(searchTool, {
    ask: () => '거제 케이블카 요금', since: 0, now: () => t, proved: found => { proof = found },
    write: agreeing(async () => { t += 1_000; return JSON.stringify({ keep: [1], asked: 1, points: ['요금: 원화 금액'], open: 1, holds: { 1: { '요금: 원화 금액': '왕복 1만 5천 원' } }, search: '거제 케이블카 요금표' }) }),
    read: async page => { opened.push(page); t += 1_000; return '거제 케이블카 소식\n어른 왕복 1만 5천 원이에요.' },
  }).run({ query: 'q' }, { task: '거제 케이블카 요금' })
  expect(opened).toEqual([url])
  expect(queries).toEqual(['q'])
  expect(proof).toEqual([{ point: '요금: 원화 금액', quote: '왕복 1만 5천 원', url }])
})
