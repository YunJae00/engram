import { afterEach, expect, test } from 'vitest'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { handoffBrief, mergedReport, reportData, setReportLog, staffTool, teamSummary, TEAM_MEMORY, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const CHECK = 'Judge meaning only', REDO = 'You fix a message'
const insert = (after: number, ...lines: string[]): string => JSON.stringify({ insert_after: { [after]: lines } })
const none = JSON.stringify({ problems: [] })
function model(drafts: string[], verdicts: string[] = []) {
  const calls: string[] = []
  const write = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? verdicts.shift() ?? none : drafts.shift() ?? '' }
  return { write, calls }
}
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

test('a summary that folds jobs into a count ("배송 정책 세 곳") is refused as missing, naming the subject, and the repair names every one', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await today()
  const added = '쿠팡·마켓컬리·11번가 배송 정책이었어요.'
  const { write, calls } = model([FOLDED, insert(1, added)], [none])
  expect(await teamSummary(paths, { bots, message: ASK, now, write })).toBe(`${FOLDED}\n${added}`)
  expect(calls[0]).toContain('never folded into a count')
  expect(calls[1]).toContain(CHECK)
  expect(calls[1]).toContain('"missing": the message must name what each of these was about')
  expect(calls[1]).toContain('연말 프로모션 문구')
  expect(calls[2]).toContain(REDO)
  expect(calls[2]).toContain('"kind":"shape"')
  for (const subject of ['쿠팡 배송 정책', '마켓컬리 배송 정책', '11번가 배송 정책']) expect(calls[2]).toContain(subject)
  expect(logged).toEqual([expect.stringMatching(/^summary=repaired:shape:missing /)])
})

test('a summary refused twice is the host\'s, and it names every subject, the hand-off, and who has left', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await today()
  const out = await teamSummary(paths, { bots, message: ASK, now, write: model([FOLDED, FOLDED]).write })
  expect(out).toMatch(/^오늘은 /)
  for (const subject of ['쿠팡', '마켓컬리', '11번가', '연말 프로모션 문구']) expect(out).toContain(subject)
  expect(out).not.toContain('세 곳')
  expect(out).toContain('소윤은 이제 팀에 없어요.')
  expect(logged).toEqual([expect.stringMatching(/^summary=fallback:missing /)])
})

test('grouping by listing the subjects passes; a meaning check that still finds one missing sends it to the repair', async () => {
  const { paths, bots, now } = await today()
  const listed = '오늘은 하은, 준, 소윤이 쿠팡·마켓컬리·11번가 배송 정책을 봤는데 새로 나온 게 없었어요. 준은 하은이 찾은 걸로 연말 프로모션 문구를 썼어요. 소윤은 이제 팀에 없어요.'
  expect(await teamSummary(paths, { bots, message: ASK, now, write: model([listed], [none]).write })).toBe(listed)
  const flagged = JSON.stringify({ problems: [{ kind: 'missing', quote: '11번가 배송 정책', why: '안 나왔어요' }] })
  const { write, calls } = model([listed, insert(1, '11번가 배송 정책도 소윤이 봤어요.')], [flagged, none])
  expect(await teamSummary(paths, { bots, message: ASK, now, write })).toBe(`${listed}\n11번가 배송 정책도 소윤이 봤어요.`)
  expect(calls[2]).toContain(REDO)
  expect(calls[2]).toContain('"kind":"missing"')
})

const block = (report: Record<string, unknown>): string => `\`\`\`report\n${JSON.stringify(report)}\n\`\`\``
const part = (id: string, role: string, brief: string, more: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: new Date().toISOString(), ...more })
const reported = (m: TeamMember, report: Record<string, unknown>): TeamMember => {
  const one: TeamMember = { ...m }, answer = block(report)
  settleMember(one, { answer, report: reportData(answer, one, [], true) ?? null }, new Date().toISOString(), true)
  return one
}
const SALE = 'https://shop.example.kr/year-end-sale'
function handOff(): TeamMember[] {
  const haeun = reported(part('m1', '하은', '연말 할인 행사 조사', { background: true, topic: '연말 할인 행사', then: { botId: 'bot-m2', who: '준', brief: '프로모션 문구 두 개 쓰기' } }), { facts: [{ text: '12월 20일부터 연말 할인이 시작돼요.', url: SALE }] })
  const jun = reported(part('m2', '준', handoffBrief('프로모션 문구 두 개 쓰기', '하은', haeun.result!, haeun.brief), { background: true, lookup: undefined, writer: true }), { items: ['올해 마지막 할인, 놓치지 마세요', '12월 20일, 장바구니를 채우세요'] })
  return [haeun, jun]
}

const LINES = ['1. 올해 마지막 할인, 놓치지 마세요', '2. 12월 20일, 장바구니를 채우세요']
test('a writer draft that opens on the items and then says whose find they came from, with no link, is accepted; the host closes that sentence with the link', async () => {
  setReportLog(line => logged.push(line))
  const members = handOff()
  const draft = JSON.stringify({ message: `${LINES.join('\n')}\n\n하은이 찾은 연말 할인으로 준이 쓴 거예요.`, kept: [] })
  const out = await writtenReport({ ask: '할인 행사 찾아서 준한테 넘겨 문구 써줘', members, write: model([draft], [none]).write })
  expect(out.split('\n').slice(0, 2)).toEqual(LINES)
  expect(out.trimEnd().split('\n').at(-1)).toBe(`하은이 찾은 연말 할인으로 준이 쓴 거예요. [shop.example.kr](${SALE})`)
  expect(out).not.toMatch(/^\(/m)
  expect(logged).toEqual([expect.stringMatching(/^writer=accepted /)])
})

test('a draft that opens on a sentence about the work, before the items, is shown as the writer wrote it (c19a: items-first is no longer a check)', async () => {
  setReportLog(line => logged.push(line))
  const members = handOff()
  const narrated = JSON.stringify({ message: `준이 하은이 찾은 연말 할인으로 문구 두 개를 써 봤어요.\n\n${LINES.join('\n')}`, kept: [] })
  const repair = JSON.stringify({ replace: { 1: '' }, insert_after: { 3: ['하은이 찾은 연말 할인으로 준이 쓴 거예요.'] } })
  const out = await writtenReport({ ask: '연말 세일 알아보고 준이 카피 뽑게 해', members, write: model([narrated, repair]).write })
  expect(out.split('\n')).toEqual([`준이 하은이 찾은 연말 할인으로 문구 두 개를 써 봤어요. [shop.example.kr](${SALE})`, '', ...LINES])
  expect(logged).toEqual([expect.stringMatching(/^writer=accepted /)])
  logged.length = 0
  expect((await writtenReport({ ask: '연말 세일 알아보고 준이 카피 뽑게 해', members, write: model([narrated, narrated]).write })).split('\n')).toEqual([`준이 하은이 찾은 연말 할인으로 문구 두 개를 써 봤어요. [shop.example.kr](${SALE})`, '', ...LINES])
  expect(logged).toEqual([expect.stringMatching(/^writer=accepted /)])
})

test('a draft that names nobody it was made from is refused; the host\'s fallback opens on the items and says whose they are after, never a "(name, …)" tag', async () => {
  const members = handOff()
  const nobody = JSON.stringify({ message: `${LINES.join('\n')}\n\n준이 써 봤어요.`, kept: [] })
  const out = await writtenReport({ ask: '할인 행사 찾아서 준한테 넘겨 문구 써줘', members, write: model([nobody, nobody]).write })
  expect(out.split('\n').filter(Boolean)).toEqual([...LINES, `준이 써 봤어요. [shop.example.kr](${SALE})`])
  const host = mergedReport(members)
  expect(host.split('\n')).toEqual([...LINES, `준이 하은이 찾은 연말 할인 행사로 만든 거예요. [shop.example.kr](${SALE})`])
  expect(host).not.toMatch(/\(준|\(하은/)
})

test('one writer with no hand-off: the items first, then whose they are', () => {
  const solo = reported(part('m1', '다온', '송년회 초대 문구 두 줄', { lookup: false, writer: true }), { items: ['한 해 수고 많으셨어요, 같이 마무리해요', '12월 27일 저녁, 자리 비워 두세요'] })
  expect(mergedReport([solo]).split('\n')).toEqual(['1. 한 해 수고 많으셨어요, 같이 마무리해요', '2. 12월 27일 저녁, 자리 비워 두세요', '다온이 만든 거예요.'])
})

test('side by side, each part keeps its "part(name):" row label (rule 7)', () => {
  const a = reported(part('m1', '하은', '쿠팡 배송 정책 조사', { topic: '쿠팡' }), { facts: [{ text: '쿠팡은 새벽 배송 기준을 바꿨어요.', url: 'https://news.example.kr/coupang' }] })
  const b = reported(part('m2', '준', '마켓컬리 배송 정책 조사', { topic: '마켓컬리' }), { facts: [{ text: '마켓컬리는 무료 배송 기준을 올렸어요.', url: 'https://news.example.kr/kurly' }] })
  const shown = mergedReport([a, b])
  expect(shown).toMatch(/^쿠팡\(하은\): /m)
  expect(shown).toMatch(/^마켓컬리\(준\): /m)
  expect(shown).not.toContain('찾아보니')
})

test('a job whose subject is part of another job\'s word is still checked: naming only the longer one is missing', async () => {
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
  const both = '오늘은 하은이 쿠팡, 준이 쿠팡이츠 수수료를 봤는데 둘 다 새로 나온 게 없었어요.'
  const { write, calls } = model([half, insert(2, '하은은 쿠팡 수수료를 봤어요.')], [none])
  expect(await teamSummary(paths, { bots, message: '오늘 다들 뭐 했어', now, write })).toBe(`${half}\n하은은 쿠팡 수수료를 봤어요.`)
  expect(calls[2]).toContain('쿠팡 수수료')
  expect(logged).toEqual([expect.stringMatching(/^summary=repaired:shape:missing /)])
  void both
})

async function nested(dids: [string, string]) {
  const paths = await initVault(await tmpVaultRoot('c17c-r3'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const staff = staffTool(paths, () => undefined)
  await staff.run({ add: [{ name: '하은', role: '리서치 담당' }, { name: '준', role: '리서치 담당' }] }, { task: '' })
  await recordFacts(paths, TEAM_MEMORY, [`${dids[0]} → 못 찾았어요 (하은, 2026-11-18)`, `${dids[1]} → 못 찾았어요 (준, 2026-11-18)`], new Date('2026-11-18T01:00:00.000Z'))
  return { paths, bots: await loadBots(paths), now: new Date(2026, 10, 18, 10) }
}
test('a job whose words are all inside another job\'s is still checked: naming only the longer one is missing', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await nested(['배민 광고 요금 조사', '배민 광고 요금 인상 조사'])
  const half = '오늘은 하은이랑 준이 배민 광고 요금 인상을 봤는데 새로 나온 게 없었어요.'
  const both = '오늘은 하은이 배민 광고 요금이랑 준이 배민 광고 요금 인상을 봤는데 둘 다 새로 나온 게 없었어요.'
  const { write, calls } = model([half, JSON.stringify({ replace: { 1: both } })], [none])
  expect(await teamSummary(paths, { bots, message: '오늘 누가 뭐 했어', now, write })).toBe(both)
  expect(calls[2]).toContain('배민 광고 요금')
  expect(logged).toEqual([expect.stringMatching(/^summary=repaired:shape:missing /)])
})
test('nested jobs said in separate sentences both pass the first time', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await nested(['쿠팡 배송 정책 조사', '쿠팡 배송 정책 변경 조사'])
  const apart = '오늘 하은은 쿠팡 배송 정책을 봤어요. 준은 쿠팡 배송 정책 변경을 봤는데 둘 다 새로 나온 게 없었어요.'
  const { write } = model([apart], [none])
  expect(await teamSummary(paths, { bots, message: '오늘 누가 뭐 했어', now, write })).toBe(apart)
  expect(logged).toEqual([expect.stringMatching(/^summary=clean /)])
})
