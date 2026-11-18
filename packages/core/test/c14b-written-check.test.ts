import { expect, test } from 'vitest'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { latestName, mergedReport, reportData, reportPrompt, staffTool, teamSummary, TEAM_MEMORY, writtenReport } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { CHECK_MIN_MS, checkedWrite, checkPrompt, readProblems } from '../src/written-check.js'
import { tmpVaultRoot } from './helpers.js'

const CHECK = 'Judge meaning only', REDO = 'You fix a message'
const repair = (replace: Record<number, string>): string => JSON.stringify({ replace })
const none = JSON.stringify({ problems: [] })
const problem = (kind: string, quote: string) => JSON.stringify({ problems: [{ kind, quote, why: '데이터와 달라요' }] })
function model(draft: string, rewrite: string, verdicts: string[]) {
  const calls: string[] = []
  const write = async (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? verdicts.shift() ?? none : prompt.includes(REDO) ? rewrite : draft }
  return { write, calls }
}

const block = (report: Record<string, unknown>): string => `\`\`\`report\n${JSON.stringify(report)}\n\`\`\``
const part = (id: string, role: string, brief: string, topic: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: new Date().toISOString() })
const reported = (m: TeamMember, report: Record<string, unknown>): TeamMember => {
  const one: TeamMember = { ...m }, answer = block(report)
  settleMember(one, { answer, report: reportData(answer, one, [], true) ?? null }, new Date().toISOString(), true)
  return one
}
const A = 'https://a.example.com/central', B = 'https://b.example.com/haemalgeun', C = 'https://c.example.com/byeolbit'
const libraries = (): TeamMember[] => [
  reported(part('m1', '하은', '이번 주말 중앙도서관 운영 확인', '중앙도서관'), { facts: [{ text: '중앙도서관은 이번 주말 휴관이에요.', url: A }] }),
  reported(part('m2', '준', '이번 주말 해맑은도서관 운영 확인', '해맑은도서관'), { facts: [{ text: '해맑은도서관은 토요일 오전 9시부터 정상 운영해요.', url: B }] }),
  reported(part('m3', '소윤', '이번 주말 별빛도서관 운영 확인', '별빛도서관'), { facts: [{ text: '별빛도서관은 이번 주말 휴관이에요.', url: C }] }),
]
const ASK = '동네 도서관 세 곳 이번 주말에 여는지 나눠서 알아봐줘'
const said = (message: string): string => JSON.stringify({ message, kept: ['f1', 'f2', 'f3'] })
const body = `중앙도서관은 하은이 봤는데 휴관이에요. [a](${A})\n해맑은도서관은 준이 봤는데 토요일 오전 9시부터 열어요. [b](${B})\n별빛도서관은 소윤이 봤는데 휴관이에요. [c](${C})`

test('a merged answer whose lead contradicts a row ("세 곳 모두 닫았어요" over one open) is rewritten once from the problem, and the rewrite is shown', async () => {
  const members = libraries()
  const { write, calls } = model(said(`세 곳 모두 이번 주말엔 문을 닫았어요.\n\n${body}`), repair({ 1: '해맑은도서관만 토요일에 열고, 나머지 두 곳은 쉬어요.' }), [problem('contradicts', '세 곳 모두 이번 주말엔 문을 닫았어요.'), none])
  const out = await writtenReport({ ask: ASK, members, write, timeoutMs: 5000 })
  expect(out).toMatch(/^해맑은도서관만 토요일에 열고/)
  expect(out).not.toContain('세 곳 모두')
  expect(out).toContain('해맑은도서관은 준이 봤는데 토요일 오전 9시부터 열어요.')
  expect(calls).toHaveLength(4)
  expect(calls[1]).toContain(CHECK)
  expect(calls[2]).toContain(REDO)
  expect(calls[2]).toContain('"kind":"contradicts"')
  expect(calls[1]).toContain('해맑은도서관은 토요일 오전 9시부터 정상 운영해요.')
  expect(calls[1]).toContain(JSON.stringify(ASK))
})

test('a question back to the person about a part the team can redo ("다시 찾아볼까요?") that the rewrite still holds falls to the host rendering', async () => {
  const members = libraries()
  const asking = said(`${body}\n\n별빛도서관은 다시 찾아볼까요, 아니면 다른 도서관 이름을 알려주실래요?`)
  const { write, calls } = model(asking, asking, [problem('asks', '다시 찾아볼까요'), problem('asks', '다시 찾아볼까요')])
  const out = await writtenReport({ ask: ASK, members, write, timeoutMs: 5000 })
  expect(out).not.toContain('찾아볼까요')
  expect(out).toContain('별빛도서관은 소윤이 봤는데 휴관이에요.')
  expect(calls).toHaveLength(3)
  const clean = model(said(`해맑은도서관만 열어요.\n\n${body}`), '', [none])
  expect(await writtenReport({ ask: ASK, members, write: clean.write, timeoutMs: 5000 })).toMatch(/^해맑은도서관만 열어요\./)
  expect(clean.calls).toHaveLength(2)
})

test('a late checker keeps the accepted text unchanged and adds no time past the writer\'s cap', async () => {
  const members = libraries(), draft = said(`해맑은도서관만 열어요.\n\n${body}`)
  const write = (prompt: string): Promise<string> => prompt.includes(CHECK) ? new Promise(() => undefined) : Promise.resolve(draft)
  const began = Date.now()
  const out = await writtenReport({ ask: ASK, members, write, timeoutMs: CHECK_MIN_MS + 200 })
  const took = Date.now() - began
  expect(out).toMatch(/^해맑은도서관만 열어요\./)
  expect(took).toBeGreaterThanOrEqual(CHECK_MIN_MS)
  expect(took).toBeLessThan(CHECK_MIN_MS + 600)
})

test('checkedWrite routes on the verdict only, within its deadline, with one rewrite at most', async () => {
  const input = { data: { rows: [] }, ask: '질문', draft: '초안이에요.' }
  let clock = 0
  const now = () => clock
  let asked = 0
  expect(await checkedWrite({ ...input, check: async () => { asked++; return none }, redo: async () => '고친 글', due: CHECK_MIN_MS - 1, now })).toBe('초안이에요.')
  expect(asked).toBe(0)
  expect(await checkedWrite({ ...input, check: undefined, redo: async () => '고친 글', due: 10_000, now })).toBe('초안이에요.')
  expect(await checkedWrite({ ...input, check: async () => '좋아 보여요', redo: async () => '고친 글', due: 10_000, now })).toBe('초안이에요.')
  expect(await checkedWrite({ ...input, check: async () => { clock = 9_000; return problem('contradicts', '초안') }, redo: async () => '고친 글', due: 10_000, now })).toBeUndefined()
  clock = 0
  const verdicts = [problem('unsaid', '초안'), 'x']
  expect(await checkedWrite({ ...input, check: async () => verdicts.shift(), redo: async () => '고친 글', due: 10_000, now })).toBeUndefined()
  expect(await checkedWrite({ ...input, check: async () => problem('unsaid', '초안'), redo: async () => undefined, due: 10_000, now })).toBeUndefined()
})

test('readProblems keeps the four kinds only, and "dropped" only for a rewrite', () => {
  const raw = JSON.stringify({ problems: [{ kind: 'contradicts', quote: 'a', why: 'b' }, { kind: 'style', quote: 'c' }, { kind: 'dropped', quote: 'd' }] })
  expect(readProblems(raw)?.map(p => p.kind)).toEqual(['contradicts'])
  expect(readProblems(raw, true)?.map(p => p.kind)).toEqual(['contradicts', 'dropped'])
  expect(readProblems(`검토했어요: ${none}`)).toEqual([])
  expect(readProblems('문제 없어요')).toBeUndefined()
  expect(readProblems(undefined)).toBeUndefined()
  expect(checkPrompt({ data: {}, ask: 'q' }, 'm')).not.toContain('"dropped"')
  expect(checkPrompt({ data: {}, ask: 'q', rewrite: true }, 'm')).toContain('"dropped"')
})

test('the week summary names a teammate who has left as gone: the writer\'s text is checked against "left", and the host\'s own summary says it', async () => {
  const paths = await initVault(await tmpVaultRoot('c14b-summary'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const run = (args: Record<string, unknown>) => staffTool(paths, () => undefined).run(args, { task: '' })
  await run({ add: [{ name: '하은', role: '리서치 담당' }, { name: '준호', role: '정리 담당' }] })
  const now = new Date(2026, 10, 18, 10)
  await recordFacts(paths, TEAM_MEMORY, [
    '이번 주 카페 후보 조사 → 성수동 카페 두 곳을 찾았어요 (하은, 2026-11-16)',
    '이번 주 회의실 예약 정리 → 목요일 오후로 잡았어요 (준호, 2026-11-17)',
  ], new Date('2026-11-17T03:00:00.000Z'))
  const junho = (await loadBots(paths)).find(bot => bot.name === '준호')!
  await run({ remove: ['하은'], rename: [{ who: '준호', name: '준' }] })
  const bots = await loadBots(paths)
  const at = now.toISOString()
  const task: DelegatedTask = { id: 't', goal: 'g', botId: 'chief', state: 'done', turns: 1, createdAt: at, updatedAt: at, approvals: [], log: [], team: { members: [{ id: 'm', parentId: null, depth: 1, role: '준호', brief: '이번 주 회의실 예약 정리', botId: junho.id, state: 'done', sessionKey: 's', hiredAt: at }], hires: 1, maxHires: 8, maxDepth: 3, big: false } }
  const ask = '이번 주 다들 뭐 했는지 정리해줘'
  const draft = '이번 주엔 하은이 성수동 카페 두 곳을 찾았어요. 준은 회의실을 목요일 오후로 잡았어요.'
  const fixed = '이번 주엔 하은이 성수동 카페 두 곳을 찾았어요. 하은은 지금은 팀을 떠났어요. 준은 회의실을 목요일 오후로 잡았어요.'
  const { write, calls } = model(draft, repair({ 1: '이번 주엔 하은이 성수동 카페 두 곳을 찾았어요. 하은은 지금은 팀을 떠났어요.' }), [problem('unsaid', '하은이 성수동 카페 두 곳을 찾았어요'), none])
  expect(await teamSummary(paths, { bots, tasks: [task], message: ask, now, write })).toBe(fixed)
  const data = JSON.parse(calls[1]!.split('\nData: ')[1]!.split('\nMessage: ')[0]!) as { who: string; left?: boolean }[]
  expect(data.find(job => job.who === '하은')?.left).toBe(true)
  expect(data.find(job => job.who === '준')?.left).toBeUndefined()
  const plain = await teamSummary(paths, { bots, tasks: [task], message: ask, now, write: async () => '' })
  expect(plain).toContain('하은은 이제 팀에 없어요.')
  expect(plain).toContain('준은')
  expect(plain).not.toContain('준호')
  const still = model(draft, draft, [problem('unsaid', '하은'), problem('unsaid', '하은')])
  expect(await teamSummary(paths, { bots, tasks: [task], message: ask, now, write: still.write })).toBe(plain)
})

test('a nothing-new part\'s latest change reaches the writer as one short name, never a long feature list (data shape)', () => {
  const list = '그림판 앱에 레이어 묶기, 자동 배경 지우기, 새 붓 세트, 공유 링크 권한, 팀 폴더 기능이 들어갔어요.'
  expect(latestName(list)).toBe('그림판 앱에 레이어 묶기')
  const long = '사진 편집기에서 여러 장을 한꺼번에 고를 때 쓰는 새 선택 도구가 들어가 같은 보정 값을 한 번에 적용할 수 있게 됐어요'
  expect([...latestName(long)].length).toBeLessThanOrEqual(60)
  expect(long.startsWith(latestName(long))).toBe(true)
  expect(latestName('짧은 소식이에요.')).toBe('짧은 소식이에요.')
  const m = reported(part('m1', '하은', '이번 주 그림판 앱 신기능 조사', '그림판'), { facts: [], nothing_in_period: { latest: { text: list, url: 'https://paint.example.com/notes', date: '10월 2일' } } })
  const data = JSON.parse(reportPrompt('그림판 앱 신기능 조사해줘', [m]).split('Data: ')[1]!) as { nothing?: { latest?: { text: string } } }[]
  expect(data[0]!.nothing?.latest?.text).toBe('그림판 앱에 레이어 묶기 (10월 2일)')
  expect(mergedReport([m])).toContain('팀 폴더 기능')
})

test('a lead that says every part came back, over a part that brought nothing, is checked against that part and the line that follows', async () => {
  const members = [libraries()[0]!, libraries()[1]!, { ...part('m3', '소윤', '이번 주말 별빛도서관 운영 확인', '별빛도서관'), state: 'done' as const }]
  const two = `중앙도서관은 하은이 봤는데 휴관이에요. [a](${A})\n해맑은도서관은 준이 봤는데 토요일 오전 9시부터 열어요. [b](${B})`
  const both = (lead: string) => JSON.stringify({ message: `${lead}\n\n${two}`, kept: ['f1', 'f2'] })
  const { write, calls } = model(both('세 곳 다 확인했는데 해맑은도서관만 열어요.'), repair({ 1: '해맑은도서관은 토요일에 열고 중앙도서관은 쉬어요.' }), [problem('contradicts', '세 곳 다 확인했는데'), none])
  const out = await writtenReport({ ask: ASK, members, write, timeoutMs: 5000 })
  expect(calls).toHaveLength(4)
  const data = JSON.parse(calls[1]!.split('\n').find(line => line.startsWith('Data: '))!.slice(6)) as { broughtNothing: { name: string }[]; shownAfterMessage: string }
  expect(data.broughtNothing.map(one => one.name)).toEqual(['소윤'])
  expect(data.shownAfterMessage).toContain('소윤')
  expect(out.startsWith('해맑은도서관은 토요일에 열고')).toBe(true)
  expect(out.endsWith(data.shownAfterMessage)).toBe(true)
  expect(calls[0]).toContain('Do not mention 소윤 at all')
})

test('the check reads the team message before this one, so a count that differs from what the person already read is checkable', async () => {
  const members = libraries(), before = '이번 주말엔 두 곳만 문을 열어요: 해맑은도서관과 별빛도서관이에요.'
  const { write, calls } = model(said(`해맑은도서관만 열어요.\n\n${body}`), repair({ 1: '지난번과 달리 이번에 다시 보니 해맑은도서관만 열어요.' }), [problem('contradicts', '해맑은도서관만 열어요.'), none])
  const out = await writtenReport({ ask: ASK, members, write, timeoutMs: 5000, previous: before })
  expect(calls[1]).toContain('"teamMessageBefore":"이번 주말엔 두 곳만 문을 열어요')
  expect(calls[1]).toContain('an earlier message the person already read')
  expect(out).toMatch(/^지난번과 달리/)
  const alone = model(said(`해맑은도서관만 열어요.\n\n${body}`), '', [none])
  await writtenReport({ ask: ASK, members, write: alone.write, timeoutMs: 5000 })
  expect(alone.calls[1]).not.toContain('teamMessageBefore')
})
