import { afterEach, expect, test } from 'vitest'
import { handoffBrief, koreanDates, mergedReport, setReportLog, toldHandoff, valueOf, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { deckChecked, officeTools } from '../src/office-tools.js'
import { messageUnits, quotedUnits, repairedWrite, spliced, withoutSentences } from '../src/written-check.js'

// c18b (cause F): a check named its problem precisely and was enforced by regeneration (a whole new answer, or the host's template after
// two refusals). Now it is enforced by a scoped repair: only the units a problem names change, the rest stays verbatim and in order.
// Wordings are not the harness's: a 영업팀 월간 회의, 울산/포항/경주 케이블카 요금, 민지 → 하늘 연말 이벤트 문구.
const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
const none = JSON.stringify({ problems: [] })
const problems = (...list: Record<string, unknown>[]): string => JSON.stringify({ problems: list })
function model(answers: { check?: (string | undefined)[]; repair?: (string | undefined)[]; write?: (string | undefined)[] }) {
  const calls: string[] = []
  const quick = async (prompt: string): Promise<string | undefined> => {
    calls.push(prompt)
    return prompt.includes(CHECK) ? answers.check?.shift() ?? none : prompt.includes(REPAIR) ? answers.repair?.shift() : answers.write?.shift()
  }
  return { quick, calls }
}
const logged: string[] = []
afterEach(() => { logged.length = 0; setReportLog(() => undefined) })

// --- the guard: a repair touches only what a problem names ---
const MEETING = ['영업팀 11월 월간 회의를 주요 결정 위주로 정리했어요.', '', '주요 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸', '', '미결', '- 판촉물 업체는 다음 주에 확정한다.'].join('\n')

test('a repair that only inserts the missing part is spliced in, every other line byte-equal and in order', () => {
  const units = messageUnits(MEETING)
  const insert = JSON.stringify({ insert_after: { [String(units.length - 2)]: ['', '담당자별 업무', '- 김하준: 견적 비교표, 11월 28일까지', '- 오세린: 대리점 공지, 12월 2일까지'] } })
  const out = spliced(MEETING, insert, new Set())!
  expect(out).toContain('담당자별 업무')
  // Every draft line is still there, in its order.
  const kept = out.split('\n').filter(line => MEETING.split('\n').includes(line))
  expect(kept.filter(Boolean)).toEqual(MEETING.split('\n').filter(Boolean))
})

test('a repair that rewrites a line no problem names is discarded', () => {
  const rewrite = JSON.stringify({ replace: { '1': '11월 회의 정리예요.' }, insert_after: { '4': ['담당자별 업무', '- 김하준: 견적 비교표'] } })
  expect(spliced(MEETING, rewrite, new Set())).toBeUndefined()
  // A repair that restates a kept line as a new one is the draft said again, not a repair.
  expect(spliced(MEETING, JSON.stringify({ insert_after: { '0': ['- 대리점 수수료는 동결'] } }), new Set())).toBeUndefined()
  expect(spliced(MEETING, 'not json', new Set())).toBeUndefined()
})

test('register: the copied 한다체 line becomes 해요체 and nothing else changes', async () => {
  const units = messageUnits(MEETING), quote = '판촉물 업체는 다음 주에 확정한다.'
  const at = quotedUnits(units, quote)
  expect(at).toEqual([units.length - 1])
  const { quick, calls } = model({
    check: [problems({ kind: 'register', quote, why: '한다체' })],
    repair: [JSON.stringify({ replace: { [String(at[0]! + 1)]: '- 판촉물 업체는 다음 주에 정해요.' } })],
  })
  const out = await repairedWrite({ data: { source: '' }, ask: '회의록 정리해줘', parts: true, draft: MEETING, check: quick, due: Date.now() + 15_000, log: o => logged.push(o) })
  expect(out.text).toBe(MEETING.replace('- 판촉물 업체는 다음 주에 확정한다.', '- 판촉물 업체는 다음 주에 정해요.'))
  expect(out.outcome).toBe('repaired')
  // The repair prompt names the only unit it may replace; no recheck is spent on a register finding.
  expect(calls.filter(p => p.includes(REPAIR))[0]).toContain(`Only these units may be replaced: [${at[0]! + 1}]`)
  expect(calls.filter(p => p.includes(CHECK))).toHaveLength(1)
})

test('a contradicting sentence that the repair did not fix is the only thing that goes', async () => {
  const draft = '세 곳 다 찾았어요. 울산은 성인 왕복 1만 5천 원이에요.\n포항은 1만 2천 원이에요.'
  const { quick } = model({ check: [problems({ kind: 'contradicts', quote: '세 곳 다 찾았어요.', why: '경주는 못 찾음' })], repair: ['{}'] })
  const out = await repairedWrite({ data: {}, ask: '케이블카 요금 비교해줘', draft, check: quick, due: Date.now() + 15_000 })
  expect(out.text).toBe('울산은 성인 왕복 1만 5천 원이에요.\n포항은 1만 2천 원이에요.')
  expect(out.outcome).toBe('kept')
  expect(withoutSentences(draft, [{ kind: 'shape', quote: '포항은 1만 2천 원이에요.', why: '' }])).toBe('세 곳 다 찾았어요. 울산은 성인 왕복 1만 5천 원이에요.')
})

test('a shape finding never withholds the draft: no repair, no time or no model leaves it as written', async () => {
  const shape = [{ kind: 'shape' as const, quote: '', why: 'the message opens with the items' }]
  expect((await repairedWrite({ data: {}, ask: 'a', draft: '초안이에요.', shape, check: undefined, due: Date.now() + 9000 })).text).toBe('초안이에요.')
  expect((await repairedWrite({ data: {}, ask: 'a', draft: '초안이에요.', shape, check: model({}).quick, due: Date.now() + 9000 })).text).toBe('초안이에요.')
  expect((await repairedWrite({ data: {}, ask: 'a', draft: '초안이에요.', shape, check: model({}).quick, due: Date.now() + 10 })).outcome).toBe('kept')
})

// --- the team report: shape is repaired once or accepted, never the host's template ---
const part = (id: string, role: string, brief: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: '', ...rest })
const SOURCE = 'https://event.example.com/winter'
const minji = part('m1', '민지', '연말 이벤트 조사', { then: { botId: 'bot-m2', who: '하늘', brief: '이벤트 문구 2개' }, data: { facts: [{ text: '12월 20일 성수동 겨울 마켓이 열려요.', url: SOURCE, site: '이벤트' }] } })
const ITEMS = ['성수동에서 만나는 따뜻한 겨울', '12월 20일, 겨울 마켓으로 오세요']
const haneul = part('m2', '하늘', handoffBrief('이벤트 문구 2개', '민지', `12월 20일 성수동 겨울 마켓이 열려요. — ${SOURCE}`, '연말 이벤트 조사'), { lookup: undefined, writer: true, data: { facts: [], items: ITEMS } })
const json = (message: string): string => JSON.stringify({ message, kept: [] })
const OPENS_WITH_WORK = `하늘이 민지가 찾은 겨울 마켓으로 문구 두 개를 썼어요.\n\n1. ${ITEMS[0]}\n2. ${ITEMS[1]}`

test('a writer draft that breaks items-first is repaired once in place, and never reaches the host fallback', async () => {
  setReportLog(line => logged.push(line))
  const units = messageUnits(OPENS_WITH_WORK)
  const { quick, calls } = model({ write: [json(OPENS_WITH_WORK)], repair: [JSON.stringify({ replace: { '1': '' }, insert_after: { [String(units.length)]: ['하늘이 민지가 찾은 겨울 마켓으로 쓴 거예요.'] } })] })
  const out = await writtenReport({ ask: '민지 조사 끝나면 하늘한테 문구 뽑게 해', members: [minji, haneul], write: quick, timeoutMs: 15_000 })
  expect(out.split('\n')[0]).toBe(`1. ${ITEMS[0]}`)
  expect(out).toContain('하늘이 민지가 찾은 겨울 마켓으로 쓴 거예요.')
  expect(out).toContain(SOURCE)
  expect(calls.filter(p => p.includes(REPAIR))).toHaveLength(1)
  expect(logged.join('\n')).not.toMatch(/writer=fallback/)
})

test('an items-first draft whose repair fails is shown as written, not as the host template', async () => {
  setReportLog(line => logged.push(line))
  const { quick } = model({ write: [json(OPENS_WITH_WORK)], repair: [undefined] })
  const out = await writtenReport({ ask: '민지 조사 끝나면 하늘한테 문구 뽑게 해', members: [minji, haneul], write: quick, timeoutMs: 15_000 })
  expect(out.startsWith('하늘이 민지가 찾은 겨울 마켓으로 문구 두 개를 썼어요.')).toBe(true)
  expect(out).not.toBe(mergedReport([minji, haneul]))
  expect(logged.join('\n')).toMatch(/writer=kept:items-first/)
})

test('a draft with one contradicting sentence loses only that sentence', async () => {
  const draft = `민지가 찾아보니 12월 20일 성수동 겨울 마켓이 열려요. [이벤트](${SOURCE}) 입장료는 1만 원이에요.`
  const solo = part('m1', '민지', '연말 이벤트 조사', { data: minji.data! })
  const { quick } = model({ write: [JSON.stringify({ message: draft, kept: ['f1'] })], check: [problems({ kind: 'contradicts', quote: '입장료는 1만 원이에요.', why: '자료에 없음' })], repair: [undefined] })
  const out = await writtenReport({ ask: '연말 이벤트 찾아줘', members: [solo], write: quick, timeoutMs: 15_000 })
  expect(out).toBe(`민지가 찾아보니 12월 20일 성수동 겨울 마켓이 열려요. [이벤트](${SOURCE})`)
})

// --- attribution is said once per turn ---
test('the made-from sentence is left out when this turn already named the giver and the receiver', () => {
  expect(toldHandoff(haneul, ['민지가 찾은 걸 하늘이한테 넘겼어요.'])).toBe(true)
  expect(toldHandoff(haneul, ['하늘이한테 맡겼어요.'])).toBe(false)
  const told = mergedReport([minji, haneul], new Map(), [], false, ['민지가 찾은 걸 하늘이한테 넘겼어요.'])
  expect(told).not.toMatch(/만든 거예요/)
  expect(told.split('\n').at(-1)).toContain(ITEMS[1])
  expect(told).toContain(SOURCE)
  // With no such line, one sentence says whose it is.
  expect(mergedReport([minji, haneul]).match(/만든 거예요/g)).toHaveLength(1)
})

test('with the ack in the turn, a writer draft without a made-from sentence is accepted as it is', async () => {
  const items = `1. ${ITEMS[0]}\n2. ${ITEMS[1]}`
  const { quick, calls } = model({ write: [json(items)] })
  const out = await writtenReport({ ask: '민지 조사 끝나면 하늘한테 문구 뽑게 해', members: [minji, haneul], write: quick, timeoutMs: 15_000, said: ['민지가 찾은 걸 하늘이한테 넘겼어요.'] })
  expect(out).not.toMatch(/만든 거예요|쓴 거예요/)
  expect(calls.some(p => p.includes(REPAIR))).toBe(false)
  expect(calls[0]).toContain('"toldBefore":true')
})

// --- the host's fallback writes sentences ---
const cable = (id: string, topic: string, text: string, url: string): TeamMember => part(id, `${topic}요금`, `${topic} 케이블카 요금`, { topic, data: { facts: [{ text, url, site: topic }] } })
test('the helpers fallback: three parts with evidenced values are three sentences, each with its link, no label cells', () => {
  const out = mergedReport([
    cable('h1', '울산', '요금: 대왕암공원 해상케이블카 일반 왕복 요금은 성인 기준 15,000원으로 책정되어 운영되고 있다', 'https://a.example/ulsan'),
    cable('h2', '포항', '요금: 12,000원', 'https://b.example/pohang'),
    cable('h3', '경주', '경주 케이블카는 성인 왕복 1만 원이에요.', 'https://c.example/gyeongju'),
  ], new Map(), [], true)
  const lines = out.split('\n').filter(Boolean)
  expect(lines.slice(1)).toHaveLength(3)
  for (const line of lines.slice(1)) expect(line).toMatch(/요\. \[[^\]]+\]\(https:\/\/[a-c]\.example\/[a-z]+\)$/)
  expect(out).not.toMatch(/^\|/m)
  expect(out).not.toMatch(/내용|출처|요금:/)
  expect(out).toContain('포항 요금은 12,000원으로 나와 있어요.')
  // The long quote is said by its value, never whole.
  expect(out).not.toContain('운영되고 있다')
  expect(out).toContain('울산은 요금은 성인 기준 15,000원으로 나와 있어요.')
  expect(out).toContain('경주 케이블카는 성인 왕복 1만 원이에요.')
})

test('the helpers fallback is a table only for three things on two or more points, with short value cells', () => {
  const phone = (id: string, topic: string, price: string, date: string): TeamMember => part(id, topic, `${topic} 가격 출시일`, { topic, data: { facts: [{ text: `가격: ${price}`, url: `https://p.example/${id}`, site: 'p' }, { text: `출시일: ${date}`, url: `https://d.example/${id}`, site: 'd' }] } })
  const out = mergedReport([phone('a', '태블릿 A', '89만 원', '2026.03.02'), phone('b', '태블릿 B', '72만 원', '2026.04.10'), phone('c', '태블릿 C', '65만 원', '2027.01.15')], new Map(), [], true)
  expect(out).toMatch(/^\| \| 가격 \| 출시일 \|$/m)
  expect(out).toContain('3월 2일')
  expect(out).toContain('2027년 1월 15일')
  expect(out).not.toMatch(/가격:|출시일:/)
})

test('dates are said the Korean way and a value clause is never the whole quote', () => {
  expect(koreanDates('출시일은 2026.08.12.', new Date(2026, 0, 1))).toBe('출시일은 8월 12일')
  expect(valueOf('오늘 낮 최고 기온은 18도까지 오르겠고 밤부터 비가 내리겠다고 기상청은 밝혔다')).toBe('낮 최고 기온은 18도까지')
  expect(valueOf('맑음')).toBe('맑음')
})

// --- D3: a built deck's result closes the question of whether it is done ---
test('a deck build result lists what was checked: the slide count, every title and the audit result', () => {
  const line = deckChecked([{ title: '연간 채용 현황' }, { title: '분기별 입사자' }, { title: '내년 계획' }])
  expect(line).toContain('3 slides')
  expect(line).toContain('1. 연간 채용 현황 / 2. 분기별 입사자 / 3. 내년 계획')
  expect(line).toContain('passed')
  expect(line).toContain('do not read it back')
})

test('ppt_build and word_write: a built file returns the checked verdict in its receipt; a refused deck does not', async () => {
  const tools = officeTools({ run: async () => ({ markdownLink: '[채용.pptx](engram-artifact:x)' }) })
  const run = (name: string, args: Record<string, unknown>): Promise<string> => tools.find(one => one.name === name)!.run(args, { task: '' })
  const built = JSON.parse(await run('ppt_build', { slides: [{ title: '연간 채용 현황', subtitle: '인사팀' }, { title: '분기별 입사자', bullets: ['1분기: 수치 입력'] }] })) as { checked?: string }
  expect(built.checked).toContain('2 slides (1. 연간 채용 현황 / 2. 분기별 입사자)')
  expect(await run('ppt_build', { slides: [{ title: '[제목 입력]' }] })).not.toContain('Checked before it was built')
  const doc = JSON.parse(await run('word_write', { blocks: [{ kind: 'title', text: '채용 회고' }, { kind: 'paragraph', text: '올해 채용은 목표를 넘었어요.' }] })) as { checked?: string }
  expect(doc.checked).toContain('2 blocks')
})
