import { afterEach, expect, test } from 'vitest'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { handoffBrief, mergedReport, reportData, setReportLog, staffTool, teamSummary, TEAM_MEMORY, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// c17c (cause S: the team's own summary and hand-off messages were shaped by rules that deleted what the person reads, C10 "신기능 세 곳"
// with no 노션/슬랙/리니어, and whose fallback wrote metadata, C6 "(서연, 지민이 찾은 …) 링크"). Wordings are not the harness's:
// 쿠팡 / 마켓컬리 / 11번가 배송 정책, 하은 / 준 / 소윤, 연말 프로모션 문구, "오늘 팀 뭐 했어".
const CHECK = 'Judge meaning only', REDO = 'Your earlier draft was'
const none = JSON.stringify({ problems: [] })
function model(drafts: string[], verdicts: string[] = []) {
  const calls: string[] = []
  const write = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? verdicts.shift() ?? none : drafts.shift() ?? '' }
  return { write, calls }
}
const logged: string[] = []
afterEach(() => { logged.length = 0; setReportLog(() => undefined) })

// --- the team summary names what every job was about ---
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
  // 소윤 is taken off the team afterwards: their job is still named, and said as gone.
  await staff.run({ remove: ['소윤'] }, { task: '' })
  return { paths, bots: await loadBots(paths), now: new Date(2026, 10, 18, 10) }
}
const ASK = '오늘 팀 뭐 했어'
const FOLDED = '오늘은 하은, 준, 소윤이 배송 정책 세 곳을 봤는데 새로 나온 게 없었어요. 준이 하은이 찾은 걸로 연말 프로모션 문구를 썼어요. 소윤은 이제 팀에 없어요.'

test('a summary that folds jobs into a count ("배송 정책 세 곳") is refused as missing, naming the subject, and the repair names every one', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await today()
  const fixed = '오늘은 하은, 준, 소윤이 쿠팡·마켓컬리·11번가 배송 정책을 봤는데 새로 나온 게 없었어요. 준이 하은이 찾은 걸로 연말 프로모션 문구를 썼어요. 소윤은 이제 팀에 없어요.'
  const { write, calls } = model([FOLDED, fixed], [none])
  expect(await teamSummary(paths, { bots, message: ASK, now, write })).toBe(fixed)
  // The writer is told each job's subject is named, never folded into a count.
  expect(calls[0]).toContain('never folded into a count')
  // The repair note says which subjects are missing.
  expect(calls[1]).toContain(REDO)
  expect(calls[1]).toContain('"kind":"shape"')
  for (const subject of ['쿠팡 배송 정책', '마켓컬리 배송 정책', '11번가 배송 정책']) expect(calls[1]).toContain(subject)
  // The meaning check is offered the "missing" kind with the jobs' subjects as its parts.
  expect(calls[2]).toContain(CHECK)
  expect(calls[2]).toContain('"missing": the message must name what each of these was about')
  expect(calls[2]).toContain('연말 프로모션 문구')
  expect(logged).toEqual([expect.stringMatching(/^summary=rewritten:shape:missing /)])
})

test('a summary refused twice is the host\'s, and it names every subject, the hand-off, and who has left', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await today()
  const out = await teamSummary(paths, { bots, message: ASK, now, write: model([FOLDED, FOLDED]).write })
  expect(out).toMatch(/^오늘은 /)
  for (const subject of ['쿠팡', '마켓컬리', '11번가', '연말 프로모션 문구']) expect(out).toContain(subject)
  expect(out).not.toContain('세 곳')
  expect(out).toContain('소윤은 이제 팀에 없어요.')
  expect(logged).toEqual([expect.stringMatching(/^summary=fallback:missing>missing /)])
})

test('grouping by listing the subjects passes; a meaning check that still finds one missing sends it to the repair', async () => {
  const { paths, bots, now } = await today()
  const listed = '오늘은 하은, 준, 소윤이 쿠팡·마켓컬리·11번가 배송 정책을 봤는데 새로 나온 게 없었어요. 준은 하은이 찾은 걸로 연말 프로모션 문구를 썼어요. 소윤은 이제 팀에 없어요.'
  expect(await teamSummary(paths, { bots, message: ASK, now, write: model([listed], [none]).write })).toBe(listed)
  const flagged = JSON.stringify({ problems: [{ kind: 'missing', quote: '11번가 배송 정책', why: '안 나왔어요' }] })
  const { write, calls } = model([listed, listed], [flagged, none])
  expect(await teamSummary(paths, { bots, message: ASK, now, write })).toBe(listed)
  expect(calls[2]).toContain(REDO)
  expect(calls[2]).toContain('"kind":"missing"')
})

// --- a hand-off is one person's message with its sources linked ---
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

test('a writer draft that says whose find it was made from but copies no link is accepted; the host closes that sentence with the link', async () => {
  setReportLog(line => logged.push(line))
  const members = handOff()
  const draft = JSON.stringify({ message: '준이 하은이 찾은 연말 할인으로 문구 두 개를 써 봤어요.\n\n1. 올해 마지막 할인, 놓치지 마세요\n2. 12월 20일, 장바구니를 채우세요', kept: [] })
  const out = await writtenReport({ ask: '할인 행사 찾아서 준한테 넘겨 문구 써줘', members, write: model([draft], [none]).write })
  expect(out.split('\n')[0]).toBe(`준이 하은이 찾은 연말 할인으로 문구 두 개를 써 봤어요. [shop.example.kr](${SALE})`)
  expect(out).toContain('1. 올해 마지막 할인, 놓치지 마세요')
  expect(out).not.toMatch(/^\(/m)
  expect(logged).toEqual([expect.stringMatching(/^writer=accepted /)])
})

test('a draft that names nobody it was made from is refused; the host\'s fallback opens with the attribution sentence, never a "(name, …)" tag', async () => {
  const members = handOff()
  const nobody = JSON.stringify({ message: '준이 문구 두 개를 써 봤어요.\n\n1. 올해 마지막 할인, 놓치지 마세요\n2. 12월 20일, 장바구니를 채우세요', kept: [] })
  const out = await writtenReport({ ask: '할인 행사 찾아서 준한테 넘겨 문구 써줘', members, write: model([nobody, nobody]).write })
  expect(out).toBe(mergedReport(members))
  const lines = out.split('\n')
  expect(lines[0]).toBe(`준이 하은이 찾은 연말 할인 행사로 프로모션 문구를 만들었어요. [shop.example.kr](${SALE})`)
  expect(lines.slice(1)).toEqual(['1. 올해 마지막 할인, 놓치지 마세요', '2. 12월 20일, 장바구니를 채우세요'])
  expect(out).not.toMatch(/\(준|\(하은/)
})

test('side by side, each part keeps its "part(name):" row label (rule 7)', () => {
  const a = reported(part('m1', '하은', '쿠팡 배송 정책 조사', { topic: '쿠팡' }), { facts: [{ text: '쿠팡은 새벽 배송 기준을 바꿨어요.', url: 'https://news.example.kr/coupang' }] })
  const b = reported(part('m2', '준', '마켓컬리 배송 정책 조사', { topic: '마켓컬리' }), { facts: [{ text: '마켓컬리는 무료 배송 기준을 올렸어요.', url: 'https://news.example.kr/kurly' }] })
  const shown = mergedReport([a, b])
  expect(shown).toMatch(/^쿠팡\(하은\): /m)
  expect(shown).toMatch(/^마켓컬리\(준\): /m)
  expect(shown).not.toContain('찾아보니')
})
