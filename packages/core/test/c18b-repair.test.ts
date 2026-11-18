import { afterEach, expect, test } from 'vitest'
import { handoffBrief, koreanDates, mergedReport, reportCheck, setReportLog, valueOf, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { deckChecked, officeTools } from '../src/office-tools.js'
import { runAgentLoop } from '../src/agent-loop.js'
import { MockEngine } from '../src/engine/mock.js'
import { engineCwd } from '../src/engine/types.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'
import { foreignRun, messageUnits, quotedUnits, repairedWrite, spliced, withoutSentences } from '../src/written-check.js'

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

const MEETING = ['영업팀 11월 월간 회의를 주요 결정 위주로 정리했어요.', '', '주요 결정', '- 1월 신규 요금제 출시로 확정', '- 대리점 수수료는 동결', '- 지방 순회 설명회는 2월로 미룸', '', '미결', '- 판촉물 업체는 다음 주에 확정한다.'].join('\n')

test('a repair that only inserts the missing part is spliced in, every other line byte-equal and in order', () => {
  const units = messageUnits(MEETING)
  const insert = JSON.stringify({ insert_after: { [String(units.length - 2)]: ['', '담당자별 업무', '- 김하준: 견적 비교표, 11월 28일까지', '- 오세린: 대리점 공지, 12월 2일까지'] } })
  const out = spliced(MEETING, insert, new Set())!
  expect(out).toContain('담당자별 업무')
  const kept = out.split('\n').filter(line => MEETING.split('\n').includes(line))
  expect(kept.filter(Boolean)).toEqual(MEETING.split('\n').filter(Boolean))
})

test('a repair that rewrites a line no problem names is discarded', () => {
  const rewrite = JSON.stringify({ replace: { '1': '11월 회의 정리예요.' }, insert_after: { '4': ['담당자별 업무', '- 김하준: 견적 비교표'] } })
  expect(spliced(MEETING, rewrite, new Set())).toBeUndefined()
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

const part = (id: string, role: string, brief: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: '', ...rest })
const SOURCE = 'https://event.example.com/winter'
const minji = part('m1', '민지', '연말 이벤트 조사', { then: { botId: 'bot-m2', who: '하늘', brief: '이벤트 문구 2개' }, data: { facts: [{ text: '12월 20일 성수동 겨울 마켓이 열려요.', url: SOURCE, site: '이벤트' }] } })
const ITEMS = ['성수동에서 만나는 따뜻한 겨울', '12월 20일, 겨울 마켓으로 오세요']
const haneul = part('m2', '하늘', handoffBrief('이벤트 문구 2개', '민지', `12월 20일 성수동 겨울 마켓이 열려요. — ${SOURCE}`, '연말 이벤트 조사'), { lookup: undefined, writer: true, data: { facts: [], items: ITEMS } })
const json = (message: string): string => JSON.stringify({ message, kept: [] })
const OPENS_WITH_WORK = `하늘이 민지가 찾은 겨울 마켓으로 문구 두 개를 썼어요.\n\n1. ${ITEMS[0]}\n2. ${ITEMS[1]}`

// c19a: items-first is no longer a check (the order rule lives in the writer prompt): a draft that opens on its lead is not repaired.
test('a writer draft that opens on its lead before the items is shown as written, with no repair, and never reaches the host fallback', async () => {
  setReportLog(line => logged.push(line))
  const units = messageUnits(OPENS_WITH_WORK)
  const { quick, calls } = model({ write: [json(OPENS_WITH_WORK)], repair: [JSON.stringify({ replace: { '1': '' }, insert_after: { [String(units.length)]: ['하늘이 민지가 찾은 겨울 마켓으로 쓴 거예요.'] } })] })
  const out = await writtenReport({ ask: '민지 조사 끝나면 하늘한테 문구 뽑게 해', members: [minji, haneul], write: quick, timeoutMs: 15_000 })
  expect(out.split('\n')[0]).toMatch(/^하늘이 민지가 찾은 겨울 마켓으로 문구 두 개를 썼어요\./)
  expect(out).not.toContain('하늘이 민지가 찾은 겨울 마켓으로 쓴 거예요.')
  expect(out).toContain(SOURCE)
  expect(calls.filter(p => p.includes(REPAIR))).toHaveLength(0)
  expect(logged.join('\n')).not.toMatch(/writer=fallback/)
})

test('a draft with its lead before the items is shown where the writer put it (c19a: no host move), not as the host template', async () => {
  setReportLog(line => logged.push(line))
  const { quick } = model({ write: [json(OPENS_WITH_WORK)], repair: [undefined] })
  const out = await writtenReport({ ask: '민지 조사 끝나면 하늘한테 문구 뽑게 해', members: [minji, haneul], write: quick, timeoutMs: 15_000 })
  expect(out.split('\n')[0]).toMatch(/^하늘이 민지가 찾은 겨울 마켓으로 문구 두 개를 썼어요\./)
  expect(out).toContain('하늘이 민지가 찾은 겨울 마켓으로 문구 두 개를 썼어요.')
  expect(out.indexOf('하늘이 민지가')).toBeLessThan(out.indexOf(ITEMS[0]!))
  expect(out).not.toBe(mergedReport([minji, haneul]))
  expect(logged.join('\n')).toMatch(/writer=accepted/)
})

test('a draft with one contradicting sentence loses only that sentence', async () => {
  const draft = `민지가 찾아보니 12월 20일 성수동 겨울 마켓이 열려요. [이벤트](${SOURCE}) 입장료는 1만 원이에요.`
  const solo = part('m1', '민지', '연말 이벤트 조사', { data: minji.data! })
  const { quick } = model({ write: [JSON.stringify({ message: draft, kept: ['f1'] })], check: [problems({ kind: 'contradicts', quote: '입장료는 1만 원이에요.', why: '자료에 없음' })], repair: [undefined] })
  const out = await writtenReport({ ask: '연말 이벤트 찾아줘', members: [solo], write: quick, timeoutMs: 15_000 })
  expect(out).toBe(`민지가 찾아보니 12월 20일 성수동 겨울 마켓이 열려요. [이벤트](${SOURCE})`)
})

test('the made-from sentence stays in the answer, said once, whatever the ack said', () => {
  const told = mergedReport([minji, haneul])
  expect(told.match(/하늘이 민지가 찾은 [^\n]*만든 거예요\./g)).toHaveLength(1)
  expect(told).toContain(SOURCE)
})

test('with the ack in the turn, a writer draft without a made-from sentence gets it by the one repair', async () => {
  const items = `1. ${ITEMS[0]}\n2. ${ITEMS[1]}`
  const { quick, calls } = model({ write: [json(items)], repair: [JSON.stringify({ insert_after: { 2: ['하늘이 민지가 찾은 겨울 마켓으로 쓴 거예요.'] } })] })
  const out = await writtenReport({ ask: '민지 조사 끝나면 하늘한테 문구 뽑게 해', members: [minji, haneul], write: quick, timeoutMs: 15_000, said: ['민지가 찾은 걸 하늘이한테 넘겼어요.'] })
  expect(calls.some(p => p.includes(REPAIR))).toBe(true)
  expect(out).toContain('하늘이 민지가 찾은 겨울 마켓으로 쓴 거예요.')
  expect(calls[0]).not.toContain('toldBefore')
})

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
  expect(out).not.toContain('운영되고 있다')
  expect(out).toContain('울산은 요금은 성인 기준 15,000원으로 나와 있어요.')
  expect(out).toContain('경주 케이블카는 성인 왕복 1만 원이에요.')
})

test('r2: three 수영장 compared on one point (자유수영 요금) are a table; two things on it are sentences', () => {
  const pool = (id: string, topic: string, fee: string): TeamMember => part(id, topic, `${topic} 수영장 요금`, { topic, data: { facts: [{ text: `자유수영 요금: ${fee}`, url: `https://pool.example/${id}`, site: '구청' }] } })
  const three = mergedReport([pool('a', '마포', '4,000원'), pool('b', '용산', '3,500원'), pool('c', '성동', '5,000원')], new Map(), [], true)
  expect(three).toMatch(/^\| \| 자유수영 요금 \|$/m)
  expect(three).toContain('| 용산 | 3,500원 [구청](https://pool.example/b) |')
  const none = part('d', '강서', '강서 수영장 요금', { topic: '강서', sources: ['https://pool.example/gangseo'], data: { facts: [] } })
  expect(mergedReport([pool('a', '마포', '4,000원'), pool('b', '용산', '3,500원'), none], new Map(), [], true)).toMatch(/^\| 강서 \| 못 찾았어요 \[[^\]]+\]\(https:\/\/pool\.example\/gangseo\) \|$/m)
  expect(mergedReport([pool('a', '마포', '4,000원'), none], new Map(), [], true)).toMatch(/강서는 이번엔 못 찾았어요\. \[[^\]]+\]\(https:\/\/pool\.example\/gangseo\)/)
  const two = mergedReport([pool('a', '마포', '4,000원'), pool('b', '용산', '3,500원')], new Map(), [], true)
  expect(two).not.toMatch(/^\|/m)
  expect(two).toContain('[구청](https://pool.example/b)')
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

test('r2: a register-only repair that adds a line, or English the draft and data do not hold, is discarded and the draft stands', async () => {
  const draft = '인사팀 회의는 목요일에 해요.\n채용 공고는 다음 달에 올린다.'
  const register = problems({ kind: 'register', quote: '채용 공고는 다음 달에 올린다.', why: '한다체' })
  const fixLine = { replace: { '2': '채용 공고는 다음 달에 올려요.' } }
  const notes = { source: '- 채용 공고는 다음 달에 올린다.' }, quoted = '인사팀 회의는 목요일에 해요.\n"채용 공고는 다음 달에 올린다"라고 적혀 있어요.'
  const added = model({ check: [register], repair: [JSON.stringify({ ...fixLine, insert_after: { '2': ['채용 일정은 따로 정리해 둘게요.'] } })] })
  expect((await repairedWrite({ data: notes, ask: '회의 정리해줘', draft, check: added.quick, due: Date.now() + 15_000 })).text).toBe(quoted)
  expect(added.calls.find(p => p.includes(REPAIR))).toContain('Add no new lines')
  const english = model({ check: [register], repair: [JSON.stringify({ replace: { '2': 'We will post the job ad next month.' } })] })
  expect((await repairedWrite({ data: notes, ask: '회의 정리해줘', draft, check: english.quick, due: Date.now() + 15_000 })).text).toBe(quoted)
  const clean = model({ check: [register], repair: [JSON.stringify(fixLine)] })
  expect((await repairedWrite({ data: {}, ask: '회의 정리해줘', draft, check: clean.quick, due: Date.now() + 15_000 })).text).toBe('인사팀 회의는 목요일에 해요.\n채용 공고는 다음 달에 올려요.')
})

test('r2: English the data holds (a product name) is not foreign; a missing part may still insert lines', () => {
  expect(foreignRun('가격이에요.', 'Galaxy Tab S Ultra Max 가격', 'Galaxy Tab S Ultra Max')).toBeUndefined()
  expect(foreignRun('가격이에요.', 'Here is the latest price now', '')).toBe('Here is the latest price now')
  expect(foreignRun('It is fine.', 'Here is the latest price now', '')).toBeUndefined()
  expect(spliced('결정만 있어요.', JSON.stringify({ insert_after: { '1': ['할 일', '- 공지 발송'] } }), new Set(), true)).toBe('결정만 있어요.\n할 일\n- 공지 발송')
  expect(spliced('결정만 있어요.', JSON.stringify({ insert_after: { '1': ['할 일', '- 공지 발송'] } }), new Set(), false)).toBeUndefined()
})

const library = (id: string, role: string, text: string, url: string): TeamMember => part(id, role, '도서관 운영시간 조사', { data: { facts: [{ text, url, site: '도서관' }] } })
// c19a: who found what is asked only where two or more parts merge; one teammate's own hand-back gets no host attribution sentence.
test('r2: a one-teammate draft that names nobody is shown as written, with no host attribution', async () => {
  const yuna = library('y', '유나', '주말에는 오후 5시까지 열어요.', 'https://lib.example/weekend')
  const draft = `주말에는 오후 5시까지 열어요. [도서관](https://lib.example/weekend)`
  const { quick } = model({ write: [JSON.stringify({ message: draft, kept: ['f1'] })], repair: [undefined] })
  const out = await writtenReport({ ask: '유나한테 도서관 주말 운영시간 알아보라고 해', members: [yuna], write: quick, timeoutMs: 15_000 })
  expect(out).toBe('주말에는 오후 5시까지 열어요. [도서관](https://lib.example/weekend)')
})

// c19a: withEveryone is gone; the host writes no name into a draft. An unnamed teammate where two or more parts merge is a soft "unnamed"
// finding for the one scoped repair, quoting the sentence their link closes; the draft text itself is never changed by the check.
const checked = (message: string, members: TeamMember[]) => { const out = reportCheck(JSON.stringify({ message }), members); if (!('text' in out)) throw new Error(out.refused); return out }
const unnamedOf = (out: ReturnType<typeof checked>): string[] => out.soft.filter(one => one.refused === 'unnamed').map(one => one.quote ?? '')
test('r2: an unnamed teammate in a merged message is a soft finding quoting their own sentence; the named, the told and a one-part message are left alone', () => {
  const yuna = library('y', '유나', '평일은 밤 9시까지예요.', 'https://lib.example/weekday'), taeo = library('t', '태오', '월요일은 쉬어요.', 'https://lib.example/closed')
  const text = '- 평일은 밤 9시까지예요. [도서관](https://lib.example/weekday)\n태오 말로는 월요일은 쉬어요. [도서관](https://lib.example/closed)'
  const two = checked(text, [yuna, taeo])
  expect(two.text).toBe(text)
  expect(unnamedOf(two)).toEqual([expect.stringContaining('평일은 밤 9시까지예요.')])
  const one = checked('도서관 두 곳 다 봤어요. 평일은 밤 9시까지예요. [도서관](https://lib.example/weekday)', [yuna])
  expect(one.text).toBe('도서관 두 곳 다 봤어요. 평일은 밤 9시까지예요. [도서관](https://lib.example/weekday)')
  expect(one.soft).toEqual([])
  const both = checked('평일은 밤 9시까지예요. [도서관](https://lib.example/weekday) 월요일은 쉬어요. [도서관](https://lib.example/closed)', [yuna, taeo])
  expect(both.text).not.toMatch(/유나|태오|찾아보니/)
  expect(unnamedOf(both)).toHaveLength(2)
  const table = checked('| 평일 | 밤 9시 [도서관](https://lib.example/weekday) |', [yuna])
  expect(table.text).toBe('| 평일 | 밤 9시 [도서관](https://lib.example/weekday) |')
  expect(table.soft).toEqual([])
})

const garden = (id: string, role: string, text: string): TeamMember => part(id, role, '수목원 운영 조사', { data: { facts: [{ text, url: 'https://garden.example/hours', site: '수목원' }] } })
test('r3: two teammates citing one page are each an unnamed finding, in any order, and the draft is not rewritten', () => {
  const draft = '정기 휴관일은 매주 화요일이에요. [수목원](https://garden.example/hours)\n야간 개장은 금요일 저녁 9시까지예요. [수목원](https://garden.example/hours)'
  const a = garden('a', '다온', '정기 휴관일은 매주 화요일이에요.'), b = garden('b', '시우', '야간 개장은 금요일 저녁 9시까지예요.')
  // c19a: both are soft "unnamed" findings for the writer's repair, in any order; the host inserts no "찾아보니" into the draft.
  for (const order of [[a, b], [b, a]]) {
    const out = checked(draft, order)
    expect(out.text).toBe(draft)
    expect(unnamedOf(out)).toHaveLength(2)
  }
  const one = checked(draft.replace('\n', ' '), [b, a])
  expect(one.text).not.toMatch(/찾아보니/)
  expect(unnamedOf(one)).toHaveLength(2)
})

test('r3: an unrepaired register line is a quotation when the notes hold it, gone when they do not, kept when it is all there is', async () => {
  const draft = '분기 예산 회의는 다음 주 수요일이에요.\n- 출장비 한도는 30만 원으로 낮춘다.\n- 비품 구매는 팀장이 승인해요.'
  const flagged = problems({ kind: 'register', quote: '출장비 한도는 30만 원으로 낮춘다.', why: '한다체' })
  const late = (): ReturnType<typeof model> => model({ check: [flagged], repair: [undefined] })
  const fromNotes = await repairedWrite({ data: { source: '출장비 한도는 30만 원으로 낮춘다.' }, ask: '예산 회의 요약해줘', parts: true, draft, check: late().quick, due: Date.now() + 15_000 })
  expect(fromNotes.text).toBe(draft.replace('- 출장비 한도는 30만 원으로 낮춘다.', '- "출장비 한도는 30만 원으로 낮춘다"라고 적혀 있어요.'))
  const own = await repairedWrite({ data: { source: '출장비 30만' }, ask: '예산 회의 요약해줘', draft, check: late().quick, due: Date.now() + 15_000 })
  expect(own.text).not.toContain('낮춘다')
  expect(own.text).toContain('비품 구매는 팀장이 승인해요.')
  const alone = '출장비 한도는 30만 원으로 낮춘다.'
  // c19b (c18b r3 #1): the only sentence is said as a noun phrase of its own words, never kept in the plain form.
  expect((await repairedWrite({ data: {}, ask: '요약해줘', draft: alone, check: late().quick, due: Date.now() + 15_000 })).text).toBe('출장비 한도는 30만 원으로 낮춤')
})

// c19a: itemsFirst is gone; the check moves nothing and asks for no order (the order rule is the writer prompt's).
test('r3: items after a sentence about who made them stay where the writer put them; a draft already items-first is untouched too', () => {
  const slogan = part('s2', '루아', '축제 슬로건 2개', { lookup: undefined, writer: true, data: { facts: [], items: ['가을밤, 강가에서 만나요', '불빛 따라 걷는 축제'] } })
  const draft = '루아가 축제 슬로건을 두 개 뽑았어요.\n\n1. 가을밤, 강가에서 만나요\n2. 불빛 따라 걷는 축제\n\n마음에 드는 걸로 쓰시면 돼요.'
  expect(checked(draft, [slogan])).toEqual({ text: draft, soft: [], adds: [], unlinked: [] })
  const ready = '1. 가을밤, 강가에서 만나요\n2. 불빛 따라 걷는 축제\n\n루아가 뽑았어요.'
  expect(checked(ready, [slogan])).toEqual({ text: ready, soft: [], adds: [], unlinked: [] })
})

test('r3 D3: a deck built clean is answered with no read-back asked by the host, and the build verdict is in what the model reads next', async () => {
  const tools = officeTools({ run: async () => ({ artifact: 'a1', path: '/out/분기 실적.pptx', markdownLink: '[분기 실적.pptx](engram-artifact:a1)', completeReadback: true }) })
  const read = { name: 'file_read_package', description: 'reads a package', argsSchema: { type: 'object' }, calls: 0, run: async () => { read.calls++; return '{}' } }
  const prompts: string[] = []
  let call = 0
  const engine = new MockEngine({
    'COMET-STEP': prompt => {
      prompts.push(prompt)
      return ++call === 1
        ? JSON.stringify({ tool: 'ppt_build', args: { slides: [{ title: '분기 실적', subtitle: '영업팀' }, { title: '지역별 매출', bullets: ['수도권: 수치 입력'] }] } })
        : JSON.stringify({ tool: 'answer', args: { text: '두 장으로 만들었어요. [분기 실적.pptx](engram-artifact:a1)' } })
    },
  })
  const paths = await initVault(await tmpVaultRoot('c18b-d3'), { git: false })
  const result = await runAgentLoop({ engine, workdir: engineCwd(paths), tools: [...tools, read] }, '분기 실적 PPT 두 장 만들어줘', { guided: false })
  expect(result.incomplete).toBeUndefined()
  expect(result.steps.map(step => step.tool)).toEqual(['ppt_build'])
  expect(read.calls).toBe(0)
  expect(call).toBe(2)
  expect(prompts[1]).toContain('Checked before it was built and passed: 2 slides (1. 분기 실적 / 2. 지역별 매출)')
  expect(prompts[1]).toContain('its receipt is that readback')
})
