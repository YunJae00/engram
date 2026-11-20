import { afterEach, expect, test } from 'vitest'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { employeesAnswer, handBacks, handedFrom, handoffBrief, partOutcome, setReportLog, staffTool, teamSummary, TEAM_MEMORY, WRITER_RULE } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

function model(drafts: string[]) {
  const calls: string[] = []
  const write = async (prompt: string): Promise<string> => { calls.push(prompt); return drafts.shift() ?? '' }
  return { write, calls }
}
const record = (prompt: string): { who: string; did: string; from?: string; left?: boolean }[] => JSON.parse(prompt.split('Record: ')[1]!) as { who: string; did: string; from?: string; left?: boolean }[]
const logged: string[] = []
afterEach(() => { logged.length = 0; setReportLog(() => undefined) })

async function today() {
  const paths = await initVault(await tmpVaultRoot('c17c-summary'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const staff = staffTool(paths, () => undefined)
  await staff.run({ add: [{ name: '하은', role: '리서치 담당' }, { name: '준', role: '카피 담당' }, { name: '소윤', role: '리서치 담당' }] }, { task: '' })
  await recordFacts(paths, TEAM_MEMORY, [
    '쿠팡 배송 정책 조사 → 못 찾았어요 (하은, 2026-11-18)',
    '마켓컬리 배송 정책 조사 → 못 찾았어요 (준, 2026-11-18)',
    '11번가 배송 정책 조사 → 못 찾았어요 (소윤, 2026-11-18)',
    '연말 프로모션 문구 (하은한테 받아서) → 1. 올해 마지막 할인, 놓치지 마세요 (준, 2026-11-18)',
  ], new Date('2026-11-18T01:00:00.000Z'))
  await staff.run({ remove: ['소윤'] }, { task: '' })
  return { paths, bots: await loadBots(paths), now: new Date(2026, 10, 18, 10) }
}
const ASK = '오늘 팀 뭐 했어'
const FOLDED = '오늘은 하은, 준, 소윤이 배송 정책 세 곳을 봤는데 새로 나온 게 없었어요. 준이 하은이 찾은 걸로 연말 프로모션 문구를 썼어요. 소윤은 이제 팀에 없어요.'


test('a summary that folds jobs into a count ("배송 정책 세 곳") is the writer\'s to avoid: the rule is in its prompt, it is asked once, and what it wrote is returned byte for byte', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await today()
  const { write, calls } = model([FOLDED])
  expect(await teamSummary(paths, { bots, message: ASK, now, write })).toBe(FOLDED)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('never folded into a count')
  expect(calls[0]).toContain('every job\'s subject is named in its own words')
  expect(logged).toEqual([expect.stringMatching(/^summary=written /)])
})

test('a writer that writes nothing or is late leaves the host\'s own summary, and it names every subject, the hand-off, and who has left', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await today()
  const out = await teamSummary(paths, { bots, message: ASK, now, write: model(['  ']).write })
  expect(out).toMatch(/^오늘은 /)
  for (const subject of ['쿠팡', '마켓컬리', '11번가', '연말 프로모션 문구']) expect(out).toContain(subject)
  expect(out).not.toContain('세 곳')
  expect(out).toContain('소윤은 이제 팀에 없어요.')
  expect(await teamSummary(paths, { bots, message: ASK, now, timeoutMs: 20, write: () => new Promise(() => undefined) })).toBe(out)
  expect(logged).toEqual([expect.stringMatching(/^summary=empty /), expect.stringMatching(/^summary=late /)])
})

test('the writer is given every job with its subject, who did it, whose work it came from and who has left, and a summary listing the subjects is returned as written', async () => {
  const { paths, bots, now } = await today()
  const listed = '오늘은 하은, 준, 소윤이 쿠팡·마켓컬리·11번가 배송 정책을 봤는데 새로 나온 게 없었어요.\n\n준은 하은이 찾은 걸로 연말 프로모션 문구를 썼어요. 소윤은 이제 팀에 없어요.'
  const { write, calls } = model([listed])
  expect(await teamSummary(paths, { bots, message: ASK, now, write })).toBe(listed)
  expect(calls).toHaveLength(1)
  expect(record(calls[0]!).map(job => [job.who, job.did])).toEqual([['하은', '쿠팡 배송 정책 조사'], ['준', '마켓컬리 배송 정책 조사'], ['소윤', '11번가 배송 정책 조사'], ['준', '연말 프로모션 문구']])
  expect(record(calls[0]!)[3]).toMatchObject({ from: '하은' })
  expect(record(calls[0]!)[2]).toMatchObject({ left: true })
})

const part = (id: string, role: string, brief: string, more: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'working', sessionKey: `s-${id}`, hiredAt: new Date().toISOString(), ...more })
const answered = (m: TeamMember, answer: string, sources: string[] = []): TeamMember => {
  const one: TeamMember = { ...m }
  settleMember(one, { answer, sources }, new Date().toISOString(), true)
  return one
}
interface Back { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
const back = (text: string | undefined): Back => JSON.parse(text!) as Back
const SALE = 'https://shop.example.kr/year-end-sale'
const FIND = `12월 20일부터 연말 할인이 시작돼요. ${SALE}`
const LINES = ['올해 마지막 할인, 놓치지 마세요', '12월 20일, 장바구니를 채우세요']
function handOff(copy = LINES.join('\n')): TeamMember[] {
  const haeun = answered(part('m1', '하은', '연말 할인 행사 조사', { background: true, topic: '연말 할인 행사', then: { botId: 'bot-m2', who: '준', brief: '프로모션 문구 두 개 쓰기' } }), FIND, [SALE])
  const jun = answered(part('m2', '준', handoffBrief('프로모션 문구 두 개 쓰기', '하은', haeun.result!, haeun.brief), { background: true, lookup: undefined, writer: true }), copy)
  return [haeun, jun]
}
const job = (members: TeamMember[]): DelegatedTask => ({ id: 't', goal: '할인 행사 찾아서 준한테 넘겨 문구 써줘', botId: 'lead', state: 'waiting', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })

test('a hand-off reaches the lead as the find with its page and the copy made from it, each as written; the host adds no link and no sentence to either', () => {
  const [haeun, jun] = handOff()
  const out = back(employeesAnswer(job([haeun!, jun!])))
  expect(out.reports.map(r => [r.who, r.result])).toEqual([['하은', FIND], ['준', LINES.join('\n')]])
  expect(out.reports[0]!.sources).toEqual([SALE])
  expect(out.reports[1]!.result).not.toContain('http')
  expect(out.reports[1]!.sources).toBeUndefined()
  expect(out.note).toContain('the last result is the deliverable; keep the facts it took from the earlier one')
})

test('a writer\'s answer that opens on a sentence about the work, before the items, is handed back as the writer wrote it (c19a: items-first is no longer a check)', () => {
  const narrated = `하은이 찾은 연말 할인으로 문구 두 개를 써 봤어요.\n\n${LINES.join('\n')}`
  const [haeun, jun] = handOff(narrated)
  expect(jun!.result).toBe(narrated)
  expect(back(handBacks([haeun!, jun!])).reports[1]!.result).toBe(narrated)
  expect(handedFrom(jun!.brief)).toMatchObject({ from: '하은', result: FIND })
  expect(WRITER_RULE).toContain('each the final text only')
})

test('copy that names nobody it was made from still reaches the lead with whose it is and whose find it came from as data; naming each of them is the lead\'s rule', () => {
  const out = back(handBacks(handOff()))
  expect(out.reports.map(r => r.who)).toEqual(['하은', '준'])
  expect(out.reports[1]!.result).not.toMatch(/하은|준/)
  expect(out.note).toContain('who did what in natural sentences that name each agent')
  expect(out.note).toContain('a file an agent made is named in their line')
  expect(JSON.stringify(out.reports)).not.toMatch(/\(준|\(하은/)
})

test('one writer with no hand-off: the lines it wrote are its result, as written, and count as found', () => {
  const lines = '한 해 수고 많으셨어요, 같이 마무리해요\n12월 27일 저녁, 자리 비워 두세요'
  const solo = answered(part('m1', '다온', '동창회 안내 글 두 줄', { lookup: false, writer: true }), lines)
  expect(solo.result).toBe(lines)
  expect(solo.data).toBeUndefined()
  expect(partOutcome(solo)).toBe('found')
  expect(back(handBacks([solo])).reports).toEqual([{ who: '다온', state: 'done', result: lines }])
})

test('side by side, each part reaches the lead with its part name and who did it (rule 7)', () => {
  const a = answered(part('m1', '하은', '쿠팡 배송 정책 조사', { topic: '쿠팡' }), '쿠팡은 새벽 배송 기준을 바꿨어요. https://news.example.kr/coupang', ['https://news.example.kr/coupang'])
  const b = answered(part('m2', '준', '마켓컬리 배송 정책 조사', { topic: '마켓컬리' }), '마켓컬리는 무료 배송 기준을 올렸어요. https://news.example.kr/kurly', ['https://news.example.kr/kurly'])
  const out = back(handBacks([a, b]))
  expect(out.reports.map(r => [r.part, r.who, r.state])).toEqual([['쿠팡', '하은', 'done'], ['마켓컬리', '준', 'done']])
  expect(out.reports.map(r => r.result)).toEqual([a.result, b.result])
  expect(out.note).toContain('their part named')
})

test('a job whose subject is part of another job\'s word is its own entry in what the writer is given, and a summary naming only the longer one is returned as written', async () => {
  setReportLog(line => logged.push(line))
  const paths = await initVault(await tmpVaultRoot('c17c-r2'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const staff = staffTool(paths, () => undefined)
  await staff.run({ add: [{ name: '하은', role: '리서치 담당' }, { name: '준', role: '리서치 담당' }] }, { task: '' })
  await recordFacts(paths, TEAM_MEMORY, [
    '쿠팡 수수료 조사 → 못 찾았어요 (하은, 2026-11-18)',
    '쿠팡이츠 수수료 조사 → 못 찾았어요 (준, 2026-11-18)',
  ], new Date('2026-11-18T01:00:00.000Z'))
  const bots = await loadBots(paths), now = new Date(2026, 10, 18, 10)
  const half = '오늘은 준이 쿠팡이츠 수수료를 봤는데 새로 나온 게 없었어요. 하은도 같이 봤어요.'
  const { write, calls } = model([half])
  expect(await teamSummary(paths, { bots, message: '오늘 팀원들 한 일 알려줘', now, write })).toBe(half)
  expect(calls).toHaveLength(1)
  expect(record(calls[0]!).map(one => one.did)).toEqual(['쿠팡 수수료 조사', '쿠팡이츠 수수료 조사'])
  expect(logged).toEqual([expect.stringMatching(/^summary=written jobs=2 /)])
})

async function nested(dids: [string, string]) {
  const paths = await initVault(await tmpVaultRoot('c17c-r3'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const staff = staffTool(paths, () => undefined)
  await staff.run({ add: [{ name: '하은', role: '리서치 담당' }, { name: '준', role: '리서치 담당' }] }, { task: '' })
  await recordFacts(paths, TEAM_MEMORY, [`${dids[0]} → 못 찾았어요 (하은, 2026-11-18)`, `${dids[1]} → 못 찾았어요 (준, 2026-11-18)`], new Date('2026-11-18T01:00:00.000Z'))
  return { paths, bots: await loadBots(paths), now: new Date(2026, 10, 18, 10) }
}
test('a job whose words are all inside another job\'s is its own entry too, and the writer\'s one summary is what the person gets', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await nested(['배민 광고 요금 조사', '배민 광고 요금 인상 조사'])
  const half = '오늘은 하은이랑 준이 배민 광고 요금 인상을 봤는데 새로 나온 게 없었어요.'
  const { write, calls } = model([half, '다시 쓴 글'])
  expect(await teamSummary(paths, { bots, message: '오늘 누가 뭐 했어', now, write })).toBe(half)
  expect(calls).toHaveLength(1)
  expect(record(calls[0]!).map(one => [one.who, one.did])).toEqual([['하은', '배민 광고 요금 조사'], ['준', '배민 광고 요금 인상 조사']])
  expect(logged).toEqual([expect.stringMatching(/^summary=written /)])
})
test('nested jobs said in separate sentences are returned as written the first time', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await nested(['쿠팡 배송 정책 조사', '쿠팡 배송 정책 변경 조사'])
  const apart = '오늘 하은은 쿠팡 배송 정책을 봤어요. 준은 쿠팡 배송 정책 변경을 봤는데 둘 다 새로 나온 게 없었어요.'
  const { write, calls } = model([apart])
  expect(await teamSummary(paths, { bots, message: '오늘 누가 뭐 했어', now, write })).toBe(apart)
  expect(calls).toHaveLength(1)
  expect(logged).toEqual([expect.stringMatching(/^summary=written /)])
})
