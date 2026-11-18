import { afterEach, expect, test } from 'vitest'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { mergedReport, reportData, setReportLog, staffTool, teamSummary, TEAM_MEMORY, writtenReport } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { checkedLead, keepsForm, turnHelpers } from '../src/lead-check.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { checkedWrite } from '../src/written-check.js'
import { tmpVaultRoot } from './helpers.js'

const CHECK = 'Judge meaning only', REDO = 'You fix a message'
const none = JSON.stringify({ problems: [] })
const problem = (kind: string, quote: string) => JSON.stringify({ problems: [{ kind, quote, why: '데이터와 달라요' }] })
function model(drafts: string[], verdicts: string[]) {
  const calls: string[] = []
  const write = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? verdicts.shift() ?? none : drafts.shift() ?? '' }
  return { write, calls }
}
const logged: string[] = []
afterEach(() => { logged.length = 0; setReportLog(() => undefined) })

const block = (report: Record<string, unknown>): string => `\`\`\`report\n${JSON.stringify(report)}\n\`\`\``
const part = (id: string, role: string, brief: string, topic: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: new Date().toISOString() })
const reported = (m: TeamMember, report: Record<string, unknown>): TeamMember => {
  const one: TeamMember = { ...m }, answer = block(report)
  settleMember(one, { answer, report: reportData(answer, one, [], true) ?? null }, new Date().toISOString(), true)
  return one
}
const F = 'https://www.figma.com/release-notes/', M = 'https://miro.com/changelog/', K = 'https://www.canva.com/newsroom/'
const LATEST = {
  피그마: '피그마는 이번 주엔 새로 낸 기능이 없고, 가장 최근엔 Dev Mode 개선이 나왔어요.',
  미로: '미로는 이번 주엔 조용했고, 가장 최근엔 AI 사이드킥 업데이트가 나왔어요.',
  캔바: '캔바는 이번 주 발표가 없었고, 가장 최근엔 매직 스튜디오 확장이 있었어요.',
}
const quietThree = (): TeamMember[] => [
  reported(part('m1', '하은', '이번 주 피그마 신기능 조사', '피그마'), { facts: [], nothing_in_period: { latest: { text: LATEST.피그마, url: F, date: '11월 3일' } } }),
  reported(part('m2', '준', '이번 주 미로 신기능 조사', '미로'), { facts: [], nothing_in_period: { latest: { text: LATEST.미로, url: M, date: '11월 5일' } } }),
  reported(part('m3', '소윤', '이번 주 캔바 신기능 조사', '캔바'), { facts: [], nothing_in_period: { latest: { text: LATEST.캔바, url: K, date: '10월 28일' } } }),
]
const ASK = '피그마, 미로, 캔바 이번 주 새 기능 하은, 준, 소윤이 나눠서 봐줘'
const msg = (message: string): string => JSON.stringify({ message, kept: [] })
const noSoyoon = msg(`이번 주엔 셋 다 조용했어요. 피그마는 하은이 봤는데 가장 최근이 Dev Mode 개선이에요. [피그마](${F}) 미로는 준이 봤는데 AI 사이드킥 업데이트가 마지막이에요. [미로](${M}) 캔바는 매직 스튜디오 확장이 마지막이에요. [캔바](${K})`)
const all = msg(`이번 주엔 셋 다 조용했어요. 피그마는 하은이 봤는데 가장 최근이 Dev Mode 개선이에요. [피그마](${F}) 미로는 준이 봤는데 AI 사이드킥 업데이트가 마지막이에요. [미로](${M}) 캔바는 소윤이 봤는데 매직 스튜디오 확장이 마지막이에요. [캔바](${K})`)

test('a team draft that leaves one teammate unnamed is repaired once with that rule, and the repair is shown (no host frame)', async () => {
  setReportLog(line => logged.push(line))
  const members = quietThree(), { write, calls } = model([noSoyoon, JSON.stringify({ insert_after: { 0: ['캔바는 소윤이 봤어요.'] } })], [none])
  const out = await writtenReport({ ask: ASK, members, write, timeoutMs: 6000 })
  expect(out).toMatch(/^캔바는 소윤이 봤어요\.\n이번 주엔 셋 다 조용했어요\./)
  expect(out).not.toBe(mergedReport(members))
  expect(calls).toHaveLength(3)
  expect(calls[1]).toContain(CHECK)
  expect(calls[2]).toContain(REDO)
  expect(calls[2]).toContain('"kind":"shape"')
  expect(calls[2]).toMatch(/every teammate is named[^"]*소윤 is missing/)
  expect(logged).toEqual([expect.stringMatching(/^writer=repaired:unnamed /)])
})

test('a team draft whose repair breaks the rule again falls to the host rendering: the shared state said once, each latest a row of its own, every sentence ended', async () => {
  setReportLog(line => logged.push(line))
  const members = quietThree(), { write } = model([noSoyoon, noSoyoon], [])
  // c19a: the host writes nothing into the draft (withEveryone is gone): the failed repair leaves the writer's own sentence as it was.
  const kept = await writtenReport({ ask: ASK, members, write, timeoutMs: 6000 })
  expect(kept).toContain('캔바는 매직 스튜디오 확장이 마지막이에요.')
  expect(kept).not.toContain('찾아보니')
  expect(logged).toEqual([expect.stringMatching(/^writer=kept:unnamed /)])
  const everyone = await writtenReport({ ask: ASK, members, write: model([all], []).write, timeoutMs: 6000 })
  expect(everyone).toContain('캔바는 소윤이 봤는데')
  expect(everyone).not.toContain('찾아보니')
  const out = mergedReport(members)
  const [head, ...rows] = out.split('\n')
  expect(head).toBe('셋 다 이번엔 새로 나온 게 없어요. 가장 최근 소식은 이래요.')
  expect(out.split('이번엔 새로 나온 게 없어요').length).toBe(2)
  expect(out).not.toMatch(/가장 최근엔 (?:피그마|미로|캔바)는/)
  rows.forEach((row, i) => {
    const [name, who] = [['피그마', '하은'], ['미로', '준'], ['캔바', '소윤']][i]!
    expect(row.startsWith(`- ${name}(${who}): ${LATEST[name as keyof typeof LATEST].slice(0, -1)} (`), row).toBe(true)
    expect(row).toMatch(/\]\(https:\/\/[^)]+\)$/)
  })
  expect(out).not.toMatch(/요 [가-힣]/)
})

test('one part that found nothing new beside one that found something: the shared line names it once, with its row under it', () => {
  const found = reported(part('m4', '도윤', '이번 주 노트북LM 신기능 조사', '노트북LM'), { facts: [{ text: '노트북LM에 영상 요약이 나왔어요.', url: 'https://blog.google/notebooklm', date: '11월 17일' }] })
  const out = mergedReport([quietThree()[0]!, found])
  const blocks = out.split('\n\n')
  expect(blocks[0]).toMatch(/^피그마\(하은\): 이번엔 새로 나온 게 없어요\. 가장 최근 소식은 이래요\.\n피그마는 이번 주엔 새로 낸 기능이 없고, 가장 최근엔 Dev Mode 개선이 나왔어요 \(11월 3일\)\. \[[^\]]+\]\(https:\/\/www\.figma\.com\/release-notes\/\)$/)
  expect(blocks[1]).toMatch(/^노트북LM\(도윤\): /)
})

async function week() {
  const paths = await initVault(await tmpVaultRoot('c15b-summary'), { git: false })
  await createBot(paths, { name: '엔그램' })
  await staffTool(paths, () => undefined).run({ add: [{ name: '하은', role: '리서치 담당' }, { name: '준', role: '정리 담당' }] }, { task: '' })
  await recordFacts(paths, TEAM_MEMORY, [
    '이번 주 동네 빵집 조사 → 망원동 빵집 세 곳을 찾았어요 (하은, 2026-11-16)',
    '이번 주 워크숍 장소 정리 → 강릉 숙소 두 곳으로 좁혔어요 (준, 2026-11-17)',
  ], new Date('2026-11-17T03:00:00.000Z'))
  return { paths, bots: await loadBots(paths), now: new Date(2026, 10, 18, 10) }
}
const WEEK_ASK = '이번 주 다들 뭐 했는지 알려줘'

test('a week summary that leaves one teammate unnamed is repaired once, and the repair is shown', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await week()
  const fixed = '이번 주엔 하은이 망원동 빵집 세 곳을 찾았어요. 준은 워크숍 장소를 강릉 숙소 두 곳으로 좁혔어요.'
  const draft = '이번 주엔 하은이 망원동 빵집 세 곳을 찾았어요. 워크숍 장소도 두 곳으로 좁혀졌어요.'
  const { write, calls } = model([draft, JSON.stringify({ insert_after: { 2: [fixed.split('. ')[1]!] } })], [none])
  expect(await teamSummary(paths, { bots, message: WEEK_ASK, now, write })).toBe(`${draft}\n${fixed.split('. ')[1]!}`)
  expect(calls).toHaveLength(3)
  expect(calls[1]).toContain(CHECK)
  expect(calls[2]).toContain('"kind":"shape"')
  expect(calls[2]).toContain('준 is missing')
  expect(logged).toEqual([expect.stringMatching(/^summary=repaired:shape:unnamed /)])
})

test('a week summary refused twice is the host\'s: a sentence mark between every person, and the fallback is logged with its rule', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await week()
  const bad = '이번 주엔 하은이 망원동 빵집 세 곳을 찾았어요.'
  const out = await teamSummary(paths, { bots, message: WEEK_ASK, now, write: model([bad, bad], []).write })
  expect(out).toContain('망원동 빵집 세 곳을 찾았어요.')
  expect(out).not.toMatch(/요 (?:하은|준)/)
  expect(out).not.toMatch(/요 [가-힣]/)
  expect(logged).toEqual([expect.stringMatching(/^summary=fallback:unnamed /)])
})

const T = 'https://travel.example.com/tokyo', O = 'https://travel.example.com/osaka'
const helper = (id: string, role: string, brief: string, result: string | undefined, sources: string[] = []): TeamMember => ({ id, parentId: null, depth: 1, role, brief, lookup: true, state: result ? 'released' : 'failed', ...(result ? { result } : {}), sources, sessionKey: `s-${id}`, hiredAt: new Date().toISOString() })
const hotels = (): TeamMember[] => [
  helper('m1', '도쿄호텔', '도쿄 시내 호텔 1박 가격', `도쿄 신주쿠 비즈니스호텔은 1박 18만 원 안팎이에요. ${T}`, [T]),
  helper('m2', '오사카호텔', '오사카 시내 호텔 1박 가격', `오사카 난바 호텔은 1박 12만 원 안팎이에요. ${O}`, [O]),
  helper('m3', '후쿠오카호텔', '후쿠오카 시내 호텔 1박 가격', undefined),
]
const HOTEL_ASK = '다음 달 도쿄, 오사카, 후쿠오카 호텔 가격 한 곳씩 따로 알아보게 해서 비교해줘'
const table = `| 도시 | 1박 가격 | 출처 |\n|---|---|---|\n| 도쿄 | 18만 원 안팎 | [트래블](${T}) |\n| 오사카 | 12만 원 안팎 | [트래블](${O}) |`

test('the lead\'s answer that says "세 곳 모두" over a part that brought nothing is checked against the helper results and rewritten once', async () => {
  const draft = `세 곳 모두 1박 12만~18만 원 사이예요.\n\n${table}`
  const fixed = `도쿄와 오사카는 따로 알아봤고, 후쿠오카는 아직 못 찾았어요.\n\n${table}`
  const { write, calls } = model([JSON.stringify({ replace: { 1: fixed.split('\n')[0] } })], [problem('contradicts', '세 곳 모두'), none])
  const lines: string[] = []
  const out = await checkedLead({ ask: HOTEL_ASK, helpers: hotels(), draft, quick: write, due: Date.now() + 8000, log: line => lines.push(line) })
  expect(out).toBe(fixed)
  expect(calls).toHaveLength(3)
  expect(calls[0]).toContain(CHECK)
  expect(calls[0]).toContain('도쿄 신주쿠 비즈니스호텔은 1박 18만 원')
  expect(calls[0]).toContain('"broughtNothing":[{"name":"후쿠오카호텔"')
  expect(calls[0]).toContain('"dropped": the person\'s ask says how the work is to be done')
  expect(calls[1]).toContain(REDO)
  expect(calls[1]).toContain('"kind":"contradicts"')
  expect(lines).toEqual([expect.stringMatching(/^lead=repaired:contradicts ms=\d+ parts=3 missing=1$/)])
})

test('the lead\'s answer that never shows the split the ask asked for is a "dropped" problem: rewritten once', async () => {
  const draft = `오사카가 가장 싸요.\n\n${table}`, fixed = `한 곳씩 따로 알아봤는데 오사카가 가장 싸요.\n\n${table}`
  const { write } = model([JSON.stringify({ replace: { 1: fixed.split('\n')[0] } })], [problem('dropped', '오사카가 가장 싸요.'), none])
  expect(await checkedLead({ ask: HOTEL_ASK, helpers: hotels(), draft, quick: write, due: Date.now() + 8000 })).toBe(fixed)
})

test('a lead rewrite with an address nobody read, a late check, or a stop keeps the lead\'s own draft (never worse than before)', async () => {
  const draft = `세 곳 모두 비슷해요.\n\n${table}`
  const invented = model([JSON.stringify({ replace: { 1: '세 곳 다 비슷해요. [다른 곳](https://made.up/page)' } })], [problem('contradicts', '세 곳 모두')])
  const kept = await checkedLead({ ask: HOTEL_ASK, helpers: hotels(), draft, quick: invented.write, due: Date.now() + 8000 })
  expect(kept).not.toContain('made.up')
  expect(kept).toContain(table)
  const stop = new AbortController(), began = Date.now()
  const hanging = async (): Promise<string | undefined> => new Promise(() => undefined)
  setTimeout(() => stop.abort(), 50)
  expect(await checkedLead({ ask: HOTEL_ASK, helpers: hotels(), draft, quick: hanging, due: Date.now() + 8000, signal: stop.signal })).toBe(draft)
  expect(Date.now() - began).toBeLessThan(500)
  const late = model([], [])
  expect(await checkedLead({ ask: HOTEL_ASK, helpers: hotels(), draft, quick: late.write, due: Date.now() + 500 })).toBe(draft)
  expect(late.calls).toEqual([])
})

test('turnHelpers takes the helpers the lead hired on this turn only, never a teammate of the person\'s team', () => {
  const since = Date.now(), old = { ...hotels()[0]!, hiredAt: new Date(since - 60_000).toISOString() }, named = { ...hotels()[1]!, botId: 'bot-1' }
  expect(turnHelpers([old, named, hotels()[2]!], since).map(m => m.role)).toEqual(['후쿠오카호텔'])
})

test('checkedWrite with shape problems: no time → host fallback; a repair with no meaning verdict is not shown (round 2)', async () => {
  const shape = [{ kind: 'shape' as const, quote: '', why: '하은 is missing' }], now = () => 0
  const fix = JSON.stringify({ insert_after: { 1: ['하은도 같이 봤어요.'] } })
  const quick = (repair: string) => async (prompt: string): Promise<string> => prompt.includes(REDO) ? repair : none
  expect(await checkedWrite({ data: {}, ask: 'a', draft: 'd', shape, check: quick(fix), due: 500, now })).toBe('d')
  expect(await checkedWrite({ data: {}, ask: 'a', draft: 'd', shape, check: undefined, due: 5000, now })).toBe('d')
  expect(await checkedWrite({ data: {}, ask: 'a', draft: 'd', shape, check: quick('not json'), due: 5000, now })).toBe('d')
  let calls = 0
  expect(await checkedWrite({ data: {}, ask: 'a', draft: 'd', shape, check: async prompt => { calls++; return quick(fix)(prompt) }, due: 5000, now })).toBe('d\n하은도 같이 봤어요.')
  expect(calls).toBe(2)
})

test('round 2 (finding 1): a structural repair whose meaning check gives no verdict, or an unreadable one, is never shown', async () => {
  const shape = [{ kind: 'shape' as const, quote: '', why: '광주 지점 is missing' }]
  const data = { branch: '광주 지점', sales: '1,240만 원' }
  for (const verdict of ['', 'not json', '{"verdict":"ok"}']) {
    let checks = 0
    const out = await checkedWrite({ data, ask: '지점별 매출 정리해줘', draft: '대전 지점만 있어요.', shape, check: async () => { checks++; return verdict }, due: Date.now() + 6000 })
    expect(out).toBe('대전 지점만 있어요.')
    expect(checks).toBe(2)
  }
  const wrongRepair = async (prompt: string): Promise<string> => prompt.includes(REDO) ? JSON.stringify({ insert_after: { 1: ['광주 지점 매출은 900만 원이에요.'] } }) : JSON.stringify({ problems: [{ kind: 'contradicts', quote: '900만 원', why: '1,240만 원' }] })
  expect(await checkedWrite({ data, ask: '지점별 매출 정리해줘', draft: '대전 지점만 있어요.', shape, check: wrongRepair, due: Date.now() + 6000 })).toBe('대전 지점만 있어요.')
})

test('round 2 (finding 2): a rewrite of the lead\'s answer that drops the comparison table or a link is refused, the draft stands; one that keeps them is shown', async () => {
  const S = 'https://sq.example/racket', W = 'https://wl.example/racket'
  const helper = (id: string, role: string, result: string, url: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief: `${role} 라켓 가격`, lookup: true, state: 'released', result: `${result} ${url}`, sources: [url], sessionKey: id, hiredAt: new Date().toISOString() })
  const helpers = [helper('h1', '요넥스', '요넥스 아스트록스 21만 원', S), helper('h2', '윌슨', '윌슨 블레이드 25만 원', W)]
  const draft = `| 브랜드 | 가격 | 출처 |\n|---|---|---|\n| 요넥스 | 23만 원 | [링크](${S}) |\n| 윌슨 | 25만 원 | [링크](${W}) |`
  const wrong = JSON.stringify({ problems: [{ kind: 'contradicts', quote: '23만 원', why: '21만 원' }] })
  const run = async (rewrite: string): Promise<string> => {
    let n = 0
    return checkedLead({ ask: '배드민턴 라켓 두 브랜드 가격 비교표로, 출처 달아서', helpers, draft, quick: async () => ++n === 1 ? wrong : n === 2 ? rewrite : none, due: Date.now() + 8000 })
  }
  const withoutWrong = draft.replace(/\n\| 요넥스[^\n]*/, '')
  expect(await run(JSON.stringify({ replace: { 1: '요넥스는 21만 원, 윌슨은 25만 원이에요.', 3: '' } }))).toBe(withoutWrong)
  expect(await run(JSON.stringify({ replace: { 3: `| 요넥스 | 21만 원 | [링크](${S}) |`, 4: '' } }))).toBe(withoutWrong)
  const fixed = draft.replace('23만 원', '21만 원')
  expect(await run(JSON.stringify({ replace: { 3: `| 요넥스 | 21만 원 | [링크](${S}) |` } }))).toBe(fixed)
  expect(keepsForm(draft, fixed)).toBe(true)
})

test('round 3: a rewrite of the lead\'s answer that keeps the row and link counts but turns one compared subject into another, or moves a source onto another subject, is refused', async () => {
  const B = 'https://bk.example/gym', P = 'https://pg.example/gym', J = 'https://jj.example/gym'
  const helper = (id: string, role: string, result: string, url: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief: `${role} 헬스장 월 회비`, lookup: true, state: 'released', result: `${result} ${url}`, sources: [url], sessionKey: id, hiredAt: new Date().toISOString() })
  const helpers = [helper('h1', '분당', '분당 월 6만 원', B), helper('h2', '판교', '판교 월 8만 원', P), helper('h3', '정자', '정자 월 5만 원', J)]
  const draft = `| 동네 | 월 회비 | 출처 |\n|---|---|---|\n| 분당 | 7만 원 | [보기](${B}) |\n| 판교 | 8만 원 | [보기](${P}) |\n| **정자** | 5만 원 | [보기](${J}) |`
  const wrong = JSON.stringify({ problems: [{ kind: 'contradicts', quote: '7만 원', why: '6만 원' }] })
  const run = async (rewrite: string): Promise<string> => {
    let n = 0
    return checkedLead({ ask: '동네 헬스장 세 곳 월 회비 표로 비교해 줘', helpers, draft, quick: async () => ++n === 1 ? wrong : n === 2 ? rewrite : none, due: Date.now() + 8000 })
  }
  const withoutWrong = draft.replace(/\n\| 분당[^\n]*/, '')
  expect(await run(JSON.stringify({ replace: { 3: `| 분당 | 6만 원 | [보기](${B}) |`, 4: `| 분당 | 6만 원 | [보기](${P}) |` } }))).toBe(withoutWrong)
  expect(await run(JSON.stringify({ replace: { 3: `| 분당 | 6만 원 | [보기](${P}) |` } }))).not.toContain(`| 분당 | 6만 원 | [보기](${P}) |`)
  const fixed = draft.replace('7만 원', '6만 원')
  expect(await run(JSON.stringify({ replace: { 3: `| 분당 | 6만 원 | [보기](${B}) |` } }))).toBe(fixed)
})
