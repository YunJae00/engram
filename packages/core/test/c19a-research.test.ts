import { afterEach, expect, test } from 'vitest'
import { handoffBrief, kindChecked, mergedReport, reportCheck, setReportLog, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { helperAnswer, helperParts } from '../src/lead-check.js'
import { checkedSearch, LOOKUP_RESERVE_MS } from '../src/item-check.js'
import { TEAM_ANSWER_MS } from '../src/team-hire-tools.js'
import type { AgentTool } from '../src/agent-loop.js'

// c19a (cause H): the reader's cited words stand; the host fixes only what it can check exactly. Wordings and topics are in no harness row.
const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
const JUDGE = /Read the words alone|In "holds", for each item|Judge each item by what it is/
const logged: string[] = []
afterEach(() => { logged.length = 0; setReportLog(() => undefined) })
const at = new Date().toISOString()
const helper = (topic: string, said: string, url: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id: topic, parentId: null, depth: 1, role: `${topic} 조사`, topic, brief: `${topic} 알아봐`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: `s-${topic}`, hiredAt: at, result: said, said, sources: [url], shown: [url], ...rest })
const DUST: Record<string, [string, string]> = {
  강릉: ['강릉 오늘 미세먼지는 좋음(18㎍/㎥)이에요.', 'https://air.example/gangneung'],
  속초: ['속초 오늘 미세먼지는 좋음(22㎍/㎥)이에요.', 'https://air.example/sokcho'],
  여수: ['여수 오늘 미세먼지는 보통(41㎍/㎥)이에요.', 'https://air.example/yeosu'],
  통영: ['통영 오늘 미세먼지는 보통(37㎍/㎥)이에요.', 'https://air.example/tongyeong'],
}
const dusty = (city: string): TeamMember => helper(city, `${DUST[city]![0]} [에어코리아](${DUST[city]![1]})`, DUST[city]![1])
// A quick model that would reject every quote it were asked to judge, and a writer that writes the draft given.
function quickWith(draft: (data: { part: string; facts?: { text: string; link: string }[] }[]) => string, prompts: string[], repair = '') {
  return async (prompt: string): Promise<string> => {
    prompts.push(prompt)
    if (/Read the words alone/.test(prompt)) return JSON.stringify({ states: [] })
    if (JUDGE.test(prompt)) return JSON.stringify({ keep: [], unsure: [], same: [], holds: {} })
    if (prompt.includes(CHECK)) return JSON.stringify({ problems: [] })
    if (prompt.includes(REPAIR)) return repair
    const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { text: string; link: string }[] }[]
    return JSON.stringify({ message: draft(data), kept: [] })
  }
}
const table = (data: { part: string; facts?: { text: string; link: string }[] }[]): string => ['네 곳 모두 오늘 미세먼지는 보통 이하예요.', '', '| 도시 | 미세먼지 | 출처 |', '|---|---|---|', ...data.filter(p => p.facts?.length).map(p => `| ${p.part} | ${p.facts![0]!.text} | ${p.facts![0]!.link} |`)].join('\n')

test('1. four helpers each citing a page they were shown: four values, four links, one message, no "못 찾았어요", and no judge is asked', async () => {
  const prompts: string[] = []
  const out = await helperAnswer({ ask: '강릉 속초 여수 통영 오늘 미세먼지 각각 알아봐줘', members: ['강릉', '속초', '여수', '통영'].map(dusty), since: 0, write: quickWith(table, prompts), due: Date.now() + 20_000 })
  for (const city of ['강릉', '속초', '여수', '통영']) { expect(out).toContain(DUST[city]![0]); expect(out).toContain(`](${DUST[city]![1]})`) }
  expect(out).not.toContain('못 찾았어요')
  expect(out!.split('\n\n').length).toBeLessThanOrEqual(2)
  expect(prompts.filter(p => JUDGE.test(p))).toHaveLength(0)
  // With no writer at all, the host's rendering says the same four facts in the helpers' own words.
  const host = await helperAnswer({ ask: '강릉 속초 여수 통영 오늘 미세먼지 각각 알아봐줘', members: ['강릉', '속초', '여수', '통영'].map(dusty), since: 0, write: undefined, due: Date.now() + 20_000 })
  for (const city of ['강릉', '속초', '여수', '통영']) expect(host).toContain(`](${DUST[city]![1]})`)
  expect(host).not.toContain('못 찾았어요')
})

test('2. a part added mid-work that the writer\'s draft leaves out is added as its own line after the draft; nothing is dropped', async () => {
  setReportLog(line => logged.push(line))
  const pohang = helper('포항', '포항 오늘 미세먼지는 나쁨(81㎍/㎥)이에요. [에어코리아](https://air.example/pohang)', 'https://air.example/pohang')
  const prompts: string[] = []
  const four = (data: { part: string; facts?: { text: string; link: string }[] }[]): string => table(data.filter(p => p.part !== '포항'))
  const out = await helperAnswer({ ask: '강릉 속초 여수 통영 미세먼지 알아봐줘\n아 포항도 넣어줘', members: [...['강릉', '속초', '여수', '통영'].map(dusty), pohang], since: 0, write: quickWith(four, prompts, JSON.stringify({ replace: {} })), due: Date.now() + 20_000 })
  expect(out!.startsWith('네 곳 모두 오늘 미세먼지는 보통 이하예요.')).toBe(true)
  for (const city of ['강릉', '속초', '여수', '통영']) expect(out).toContain(`](${DUST[city]![1]})`)
  expect(out).toContain('포항 오늘 미세먼지는 나쁨(81㎍/㎥)이에요.')
  expect(out).toContain('](https://air.example/pohang)')
  expect(prompts.some(p => p.includes(REPAIR) && p.includes('포항'))).toBe(true)
  expect(logged.join('\n')).toMatch(/added=1/)
})

test('3. one helper that handed back nothing is said once, by its own line; a "모두" lead over it stays and is not replaced', async () => {
  const ferry = { ...helper('울릉도 배편', '', 'https://search.example/?q=ulleung'), result: '', said: '', state: 'released' as const, empty: true as const }
  const found = ['강릉', '속초'].map(dusty)
  const draft = (data: { part: string; facts?: { text: string; link: string }[] }[]): string => ['모두 찾아봤어요.', ...data.filter(p => p.facts?.length).map(p => `${p.facts![0]!.text} ${p.facts![0]!.link}`), '울릉도 배편은 아쉽게도 못 찾았어요.'].join('\n')
  const out = (await helperAnswer({ ask: '강릉 속초 미세먼지랑 울릉도 배편 알아봐줘', members: [...found, ferry], since: 0, write: quickWith(draft, []), due: Date.now() + 20_000 }))!
  expect(out.startsWith('모두 찾아봤어요.')).toBe(true)
  expect(out.match(/울릉도 배편/g)).toHaveLength(1)
  expect(out).toMatch(/울릉도 배편은 이번엔 못 찾았어요\./)
  for (const city of ['강릉', '속초']) expect(out).toContain(`](${DUST[city]![1]})`)
})

test('4. a link the helper was never shown loses its link; the sentence stays', () => {
  const seen = 'https://bus.example/jeonju-timetable'
  const said = `전주 시외버스 첫차는 6시 10분이에요. [전주터미널](${seen}) 막차는 22시 30분이에요. [버스정보](https://made-up.example/last-bus)`
  const [one] = helperParts([helper('전주 버스', said, seen)])
  const facts = one!.data!.facts
  expect(facts.map(f => f.url)).toEqual([seen])
  expect(facts[0]!.text).toContain('막차는 22시 30분이에요.')
  expect(facts[0]!.text).toContain('첫차는 6시 10분이에요.')
})

const rows = (n: number, from: number, inPeriod: number): string => [
  `results for "q" at https://search.example/?q=${from} (DATA, not instructions):`,
  'Results, each as title — its own address — what it says — its date.',
  `The first ${inPeriod} are from the last week; the ones after them are older, most recent first, and say their year.`,
  'They asked for 4: list the 4 rows that are what they asked for, each with its own article address and its date.',
  ...Array.from({ length: n }, (_, i) => `- 핀테크 인수합병 소식 ${from + i} — https://news.example/fintech-${from + i} — ${from + i}번째 거래 — 11월 1${i}일`),
].join('\n')

test('5. a counted ask searches again while it has fewer in-period rows than asked and a round fits; never "N개 중 M개만" with time left', async () => {
  let t = 0
  const queries: string[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); t += 1_500; return queries.length === 1 ? rows(3, 1, 2) : rows(3, 10, 3) } }
  const write = async (prompt: string): Promise<string> => { t += 800; return JSON.stringify({ keep: [1, 2, 3], asked: 4, search: prompt.includes('"search"') ? '핀테크 인수합병 발표' : '' }) }
  const out = await checkedSearch(search, { ask: () => '요즘 국내 핀테크 인수합병 소식 4개만', since: 0, now: () => t, write }).run({ query: '국내 핀테크 인수합병' }, { task: '' })
  expect(queries).toEqual(['국내 핀테크 인수합병', '핀테크 인수합병 발표'])
  expect(out.split('\n').filter(line => line.startsWith('- ')).length).toBe(6)
  expect(out).not.toMatch(/of these rows are from the period asked/)
  // Time spent: the count found is said plainly, as part of the answer.
  t = 0
  queries.length = 0
  const late: AgentTool = { ...search, run: async args => { queries.push(String(args['query'])); t = TEAM_ANSWER_MS; return rows(3, 1, 3) } }
  const short = await checkedSearch(late, { ask: () => '요즘 국내 핀테크 인수합병 소식 4개만', since: 0, now: () => t, write }).run({ query: '국내 핀테크 인수합병' }, { task: '' })
  expect(queries).toHaveLength(1)
  expect(short).toContain('3 of these rows are from the period asked, for the 4 asked, and there is no time to look further')
  expect(short).not.toContain('They asked for 4:')
  expect(TEAM_ANSWER_MS - LOOKUP_RESERVE_MS).toBeGreaterThan(0)
})

test('6. a helper\'s "3% 올랐어요" is its own sentence: the host relabels nothing, with a writer or without one', async () => {
  const water = helper('생수 2L', '생수 2L 값은 지난달보다 3% 올랐어요. [마트](https://mart.example/water)', 'https://mart.example/water')
  const [part] = helperParts([water])
  expect(part!.data!.facts.map(f => f.text)).toEqual(['생수 2L 값은 지난달보다 3% 올랐어요.'])
  const host = await helperAnswer({ ask: '생수 2L 값 알아봐', members: [water], since: 0, write: undefined, due: Date.now() + 20_000 })
  expect(host).toContain('생수 2L 값은 지난달보다 3% 올랐어요.')
  expect(host).not.toContain('못 찾았어요')
})

test('8. one teammate\'s hand-back gets no host attribution; items with a lead keep the lead where the writer put it', async () => {
  const PLACE = 'https://library.example/club'
  const garam: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '가람', brief: '독서 모임 장소 알아봐', botId: 'bot-m1', lookup: true, state: 'done', sessionKey: 's1', hiredAt: at, result: 'x', data: { facts: [{ text: '이번 달 독서 모임은 시립도서관 3층 세미나실에서 해요.', url: PLACE, site: '시립도서관' }] } }
  const one = `이번 달 독서 모임은 시립도서관 3층 세미나실에서 해요. [시립도서관](${PLACE})`
  const write1 = async (prompt: string): Promise<string> => prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : JSON.stringify({ message: one, kept: ['f1'] })
  const out = await writtenReport({ ask: '가람한테 맡겨: 독서 모임 장소', members: [garam], write: write1, timeoutMs: 15_000 })
  expect(out).toBe(one)
  const FEST = 'https://festival.example/lantern'
  const finder: TeamMember = { ...garam, id: 'm2', role: '지우', brief: '연등 축제 일정 알아봐', then: { botId: 'bot-m3', who: '다온', brief: '홍보 문구 2개 써' }, data: { facts: [{ text: '연등 축제는 5월 10일부터 열려요.', url: FEST, site: '축제' }] } }
  const daon: TeamMember = { id: 'm3', parentId: null, depth: 1, role: '다온', brief: handoffBrief('홍보 문구 2개 써', '지우', `연등 축제는 5월 10일부터 열려요. — ${FEST}`, '연등 축제 일정 알아봐'), botId: 'bot-m3', writer: true, state: 'done', sessionKey: 's3', hiredAt: at, result: 'x', data: { facts: [], items: ['오월의 밤, 연등 아래에서 만나요', '불빛 따라 걷는 봄밤 축제'] } }
  const lead = `다온이 지우가 찾은 연등 축제로 홍보 문구 두 개 썼어요. [축제](${FEST})\n1. 오월의 밤, 연등 아래에서 만나요\n2. 불빛 따라 걷는 봄밤 축제`
  const write2 = async (prompt: string): Promise<string> => prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : JSON.stringify({ message: lead, kept: [] })
  const out2 = await writtenReport({ ask: '지우는 연등 축제 일정 찾고 다온은 홍보 문구 2개 써줘', members: [finder, daon], write: write2, timeoutMs: 15_000 })
  expect(out2.split('\n')[0]).toBe(`다온이 지우가 찾은 연등 축제로 홍보 문구 두 개 썼어요. [축제](${FEST})`)
  expect(out2).not.toMatch(/찾아보니|맡아서 했어요/)
})

test('rule 7: the still line carries no source label, in the draft data and in the host\'s own line', () => {
  const slow: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '서연', topic: '슬랙', brief: '슬랙 신기능 알아봐', botId: 'bot-1', lookup: true, state: 'working', sessionKey: 's1', hiredAt: at, sources: ['https://search.naver.com/search.naver?query=slack'] }
  const out = mergedReport([slow, { ...slow, id: 'm2', role: '도윤', topic: '노션', state: 'done', result: 'x', data: { facts: [{ text: '노션은 AI 회의록을 냈어요.', url: 'https://notion.example/ai', site: '노션' }] } }])
  const line = out.split('\n').find(one => one.includes('아직 찾는 중'))!
  expect(line).not.toMatch(/\]\(|네이버/)
})

// c19a round 2: Codex r1 findings, each reproduced on wordings in no harness row.
test('r2 #1: the team kind check drops nothing a teammate brought, even when its verdict keeps none or only some', async () => {
  const facts = [
    { text: '청주 성안길 플리마켓이 토요일에 열려요.', url: 'https://market.example/cheongju-1', site: '청주장터' },
    { text: '청주 육거리시장 야시장이 금요일 밤에 열려요.', url: 'https://market.example/cheongju-2', site: '청주장터' },
  ]
  for (const verdict of ['{"keep":[],"unsure":[]}', '{"keep":[2]}', '{"keep":[1],"lists":[2],"names":{"1":"성안길 플리마켓"}}']) {
    const out = await kindChecked({ facts }, '이번 주말 청주 플리마켓', async () => verdict)
    expect(out!.facts.map(f => f.url), verdict).toEqual(facts.map(f => f.url))
    expect(out!.nothing, verdict).toBeUndefined()
  }
  // A repeat of a fact already in hand is still not added twice: that is the one thing the check removes.
  const again = await kindChecked({ facts: [facts[0]!] }, '이번 주말 청주 플리마켓', async () => '{"keep":[1,2],"same":[[1,2]]}', 1000, [facts[0]!])
  expect(again!.facts).toEqual([])
})

test('r2 #2: a teammate present by one link keeps every other fact: each goes back as its own line, whatever "kept" says', async () => {
  const B = 'https://books.example/daegu'
  const sora: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '소라', brief: '이번 달 대구 독립서점 행사 정리', botId: 'bot-m1', lookup: true, state: 'done', sessionKey: 's1', hiredAt: at, result: 'x', data: { facts: [
    { text: '수성구 책방 낭독회가 열려요.', url: `${B}/1`, site: '책방소식', date: '11월 22일' },
    { text: '동성로 독립서점 북마켓이 열려요.', url: `${B}/2`, site: '책방소식', date: '11월 23일' },
    { text: '김광석길 책방 작가와의 만남이 있어요.', url: `${B}/3`, site: '책방소식', date: '11월 29일' },
  ] } }
  const draft = `소라가 대구 책방 행사를 정리해 왔어요. 22일엔 수성구 책방 낭독회가 있어요. [책방소식](${B}/1)`
  for (const kept of [undefined, [], ['f1']]) {
    const raw = JSON.stringify({ message: draft, ...(kept ? { kept } : {}) })
    const checked = reportCheck(raw, [sora])
    expect('text' in checked ? checked.unlinked.map(f => f.url) : [], String(kept)).toEqual([`${B}/2`, `${B}/3`])
    const out = await writtenReport({ ask: '이번 달 대구 독립서점 행사 알려줘', members: [sora], write: async prompt => prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : raw, timeoutMs: 15_000 })
    expect(out.startsWith(draft)).toBe(true)
    for (const n of [1, 2, 3]) expect(out).toContain(`](${B}/${n})`)
    expect(out).toContain('북마켓')
    expect(out).toContain('작가와의 만남')
    expect(out).not.toMatch(/\(소라\)/)
  }
})

test('r2 #3: in a merged message, a teammate the draft and its late repair leave unnamed is labelled beside their own find', async () => {
  const T = (id: string, role: string, topic: string, text: string, url: string): TeamMember => ({ id, parentId: null, depth: 1, role, topic, brief: `${topic} 닭갈비 1인분 값`, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: at, result: 'x', data: { facts: [{ text, url, site: '맛집' }] } })
  const members = [T('m1', '가온', '춘천', '춘천 닭갈비는 1인분 1만 4천 원이에요.', 'https://food.example/chuncheon'), T('m2', '나래', '홍천', '홍천 닭갈비는 1인분 1만 3천 원이에요.', 'https://food.example/hongcheon')]
  const prose = '춘천은 가온이 봤는데 1인분 1만 4천 원이에요. [맛집](https://food.example/chuncheon)\n홍천은 1인분 1만 3천 원이에요. [맛집](https://food.example/hongcheon)'
  const out = await writtenReport({ ask: '춘천이랑 홍천 닭갈비 값 가온 나래한테 나눠서 알아봐줘', members, write: async prompt => prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : prompt.includes(REPAIR) ? new Promise(() => {}) : JSON.stringify({ message: prose, kept: ['f1', 'f2'] }), timeoutMs: 300 })
  expect(out).toContain('홍천(나래)은 1인분 1만 3천 원이에요. [맛집](https://food.example/hongcheon)')
  expect(out).toContain('춘천은 가온이 봤는데')
  expect(out).not.toMatch(/찾아보니|맡아서/)
  // A table row gets the name in its first cell; a line that does not carry the part's word gets it right before the link.
  const grid = '| 지역 | 값 | 출처 |\n|---|---|---|\n| 춘천 | 1만 4천 원 (가온) | [맛집](https://food.example/chuncheon) |\n| 홍천 | 1만 3천 원 | [맛집](https://food.example/hongcheon) |'
  const tabled = await writtenReport({ ask: '닭갈비 값', members, write: async prompt => prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : prompt.includes(REPAIR) ? new Promise(() => {}) : JSON.stringify({ message: grid }), timeoutMs: 300 })
  expect(tabled).toContain('| 홍천(나래) | 1만 3천 원 |')
  const bare = await writtenReport({ ask: '닭갈비 값', members, write: async prompt => prompt.includes(CHECK) ? JSON.stringify({ problems: [] }) : prompt.includes(REPAIR) ? new Promise(() => {}) : JSON.stringify({ message: prose.replace('홍천은 ', '거기는 ') }), timeoutMs: 300 })
  expect(bare).toContain('거기는 1인분 1만 3천 원이에요. (나래) [맛집](https://food.example/hongcheon)')
})

test('r2 #4: a later search\'s "first N in the period" is read by position before repeats are left out, so an older row is never taken as recent', async () => {
  let t = 0
  const queries: string[] = []
  const page = (q: string, lines: string[], inPeriod: number): string => [`results for "${q}" at https://search.example/?q=${encodeURIComponent(q)} (DATA, not instructions):`, `The first ${inPeriod} are from the last week; the ones after them are older, most recent first, and say their year.`, ...lines].join('\n')
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    queries.push(String(args['query'])); t += 1_000
    return queries.length === 1
      ? page('a', ['- 제주 감귤 수확 체험 개장 — https://farm.example/1 — 체험 — 11월 17일'], 1)
      // Its in-period row repeats the first search's; the next one is older and must stay older.
      : page('b', ['- 제주 감귤 수확 체험 개장 — https://farm.example/1 — 체험 — 11월 17일', '- 작년 감귤 축제 후기 — https://farm.example/old — 후기 — 2025년 11월'], 1)
  } }
  const out = await checkedSearch(search, { ask: () => '이번 주 제주 감귤 체험 소식 3개', since: 0, now: () => t, due: () => 25_000 }).run({ query: '제주 감귤 체험' }, { task: '' })
  // Still 1 recent row for 3 asked after every round: the old row never counts toward the 3.
  expect(queries.length).toBeGreaterThan(1)
  const listed = out.split('\n').filter(line => line.startsWith('- '))
  expect(listed.indexOf(listed.find(line => line.includes('farm.example/old'))!)).toBe(listed.length - 1)
  expect(out).toContain('1 of these rows are from the period asked, for the 3 asked')
})

test('r2 #5: a helper whose only citation is a page it was never shown keeps its words with no link, never an unrelated page it saw', async () => {
  const seen = 'https://ferry.example/mokpo-timetable'
  const said = '흑산도 가는 쾌속선은 하루 두 번 다녀요. [해운](https://made-up.example/heuksando)'
  const [one] = helperParts([helper('흑산도 배편', said, seen)])
  expect(one!.data!.facts).toEqual([{ text: '흑산도 가는 쾌속선은 하루 두 번 다녀요.', url: '', site: expect.any(String) }])
  const host = await helperAnswer({ ask: '흑산도 배편 알아봐', members: [helper('흑산도 배편', said, seen)], since: 0, write: undefined, due: Date.now() + 20_000 })
  expect(host).toContain('흑산도 가는 쾌속선은 하루 두 번 다녀요.')
  expect(host).not.toMatch(/ferry\.example|made-up\.example|\]\(/)
  expect(host).not.toContain('못 찾았어요')
})
