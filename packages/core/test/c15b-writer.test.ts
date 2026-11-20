import { afterEach, expect, test } from 'vitest'
import * as core from '../src/index.js'
import { runToolSession } from '../src/agent-session.js'
import { COLLEAGUE_CORE_RULE } from '../src/agent-voice.js'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { assignTool, handBacks, setReportLog, staffTool, teamSummary, TEAM_MEMORY, type AssignHost } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { MockEngine } from '../src/engine/mock.js'
import type { EngineCwd, ToolSessionResult } from '../src/engine/types.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

interface Handed { added?: string[]; reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
class Typist extends MockEngine {
  constructor(private draft: string) { super() }
  runTools(): Promise<ToolSessionResult> { return Promise.resolve({ answer: this.draft }) }
}
const session = (draft: string, ask: string) => runToolSession({ engine: new Typist(draft), workdir: 'C:/tmp' as EngineCwd, tools: [] }, ask)
const posted = async (draft: string, ask: string): Promise<string> => (await session(draft, ask)).answer
const logged: string[] = []
afterEach(() => { logged.length = 0; setReportLog(() => undefined) })

const part = (id: string, role: string, brief: string, topic: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: '', ...rest })
const OVEN = 'https://oven.example/news', CRUST = 'https://crust.example/notice', DOUGH = 'https://dough.example/board'
const ASK = '동네 빵집 세 곳 새 메뉴 좀 봐줘. 솔, 별, 달이 한 곳씩 맡으면 돼'
const WEEK_ASK = '금주 동료들 작업 내역 들려줘'

async function week() {
  const paths = await initVault(await tmpVaultRoot('c15b-writer'), { git: false })
  await createBot(paths, { name: '엔그램' })
  await staffTool(paths, () => undefined).run({ add: [{ name: '솔', role: '조사 담당' }, { name: '별', role: '장소 담당' }] }, { task: '' })
  const now = new Date(2026, 10, 18, 10)
  await recordFacts(paths, TEAM_MEMORY, ['이번 주 동네 빵집 새 메뉴 조사 → 밤식빵이 새로 나왔어요 (솔, 2026-11-16)', '산악회 모임 장소 고르기 → 약수터 앞으로 정했어요 (별, 2026-11-17)'], now)
  return { paths, bots: await loadBots(paths), now }
}
function writer(texts: (string | undefined)[]) {
  const calls: string[] = []
  return { calls, write: async (prompt: string): Promise<string | undefined> => { calls.push(prompt); return texts.shift() } }
}

test('a team draft that leaves one teammate unnamed is posted as the lead wrote it; naming each one is the hand-back note\'s rule, not a repair', async () => {
  const draft = `세 곳 다 봤어요.\n\n오븐 빵집은 밤식빵을 냈어요. [오븐 소식](${OVEN})\n크러스트는 이번 주 새 메뉴가 없어요. [공지](${CRUST})`
  expect(await posted(draft, ASK)).toBe(draft)
  expect((JSON.parse(handBacks([])) as Handed).note).toContain('who did what in natural sentences that name each agent')
})

test('there is no host rendering to fall to: what a waited assign returns is data for the lead\'s next step, and only a hand-off without waiting closes the turn', () => {
  const sol = part('m1', '솔', '오븐 빵집 새 메뉴', '오븐', { result: `밤식빵이 새로 나왔어요. ${OVEN}`, sources: [OVEN] })
  const back = JSON.parse(handBacks([sol])) as Handed
  expect(Object.keys(back)).toEqual(['reports', 'note'])
  expect(back.reports).toEqual([{ who: '솔', part: '오븐', state: 'done', result: sol.result, sources: [OVEN] }])
  const { closes } = assignTool({} as never, {} as never, () => undefined)
  expect(typeof closes === 'function' && [closes({ wait: true }), closes({ wait: false })]).toEqual([false, true])
  for (const gone of ['mergedReport', 'writtenReport']) expect(core).not.toHaveProperty(gone)
})

test('one part that found nothing new beside one that found something: both are handed back in order, each in its own words', () => {
  const found = part('m1', '솔', '오븐 빵집 새 메뉴', '오븐', { result: `밤식빵이 새로 나왔어요. ${OVEN}` })
  const none = part('m2', '별', '크러스트 새 메뉴', '크러스트', { state: 'working' })
  settleMember(none, { answer: '이번 주에 새로 나온 메뉴 소식은 없어요.', sources: [CRUST], read: `지난달 공지: 소금빵 재출시 ${CRUST}` }, 'now', true)
  expect(none.empty).toBe(true)
  const back = JSON.parse(handBacks([found, none])) as Handed
  expect(back.reports.map(r => [r.who, r.part])).toEqual([['솔', '오븐'], ['별', '크러스트']])
  expect(back.reports[1]!.result).toContain('이번 주에 새로 나온 메뉴 소식은 없어요.')
  expect(back.reports[1]!.sources).toEqual([CRUST])
  expect(COLLEAGUE_CORE_RULE).toContain('one that found nothing, is said in one plain sentence in its place')
})

test('a week summary that leaves one teammate unnamed is the writer\'s text as written: one call, no check and no repair', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await week()
  const draft = '이번 주엔 솔이 동네 빵집 새 메뉴를 찾았어요. 모임 장소도 약수터 앞으로 정해졌어요.'
  const { write, calls } = writer([draft])
  expect(await teamSummary(paths, { bots, message: WEEK_ASK, now, write })).toBe(draft)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain('Call everyone by the name in "who"')
  expect(logged).toEqual([expect.stringMatching(/^summary=written /)])
})

test('the host writes the week summary itself only when the writer is late or says nothing, and the reason is logged', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await week()
  const empty = await teamSummary(paths, { bots, message: WEEK_ASK, now, write: writer(['  ']).write })
  const late = await teamSummary(paths, { bots, message: WEEK_ASK, now, timeoutMs: 10, write: () => new Promise(() => undefined) })
  expect(empty).toBe(late)
  for (const name of ['솔', '별']) expect(empty).toContain(name)
  expect(empty!.startsWith('이번 주엔 ')).toBe(true)
  expect(logged.map(line => line.split(' ')[0])).toEqual(['summary=empty', 'summary=late'])
})

test('the lead\'s answer that says "세 곳 모두" over a part that brought nothing is its own to get right: it is posted unchanged and the rule is in its prompt', async () => {
  const draft = `세 곳 모두 새 메뉴가 나왔어요. [오븐 소식](${OVEN})`
  expect(await posted(draft, ASK)).toBe(draft)
  expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished')
  expect(core).not.toHaveProperty('checkedLead')
})

test('the lead\'s answer that never shows the split the ask asked for is not rewritten: the voice rule asks for who did what', async () => {
  const draft = `오븐은 밤식빵, 도우는 무화과 깜빠뉴를 냈어요. [오븐 소식](${OVEN}) [도우 게시판](${DOUGH})`
  expect(await posted(draft, ASK)).toBe(draft)
  expect(COLLEAGUE_CORE_RULE).toContain('When teammates did parts of it, tell it the way a team would - who found or made what and who took it from there')
})

test('no rewrite stands between the lead and the person: a draft with an address nobody read is posted as it is, and the rule against such an address is the model\'s', async () => {
  const draft = '오븐 빵집은 밤식빵을 냈어요. [오븐](https://oven.example/made-up)'
  const result = await session(draft, ASK)
  expect(result.answer).toBe(draft)
  expect(result.files).toEqual([])
  expect(COLLEAGUE_CORE_RULE).toContain('never an address from memory or one you put together')
})

test('a waited assign hands back the parts it started on this turn only, never a part of the person\'s team from an earlier turn', async () => {
  const { paths, bots } = await week()
  const lead = bots.find(bot => bot.primary)!
  const earlier = part('m1', '별', '산악회 모임 장소 고르기', '모임', { state: 'released', result: '약수터 앞으로 정했어요.', botId: bots.find(bot => bot.name === '별')!.id })
  const task: DelegatedTask = { id: 't1', goal: ASK, botId: lead.id, state: 'running', turns: 2, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members: [earlier], hires: 1, maxHires: 8, maxDepth: 3, big: false } }
  const host: AssignHost = {
    self: null, load: async () => task, change: async change => change(task),
    run: async ids => { for (const m of task.team!.members.filter(one => ids.includes(one.id))) settleMember(m, { answer: `밤식빵이 새로 나왔어요. ${OVEN}` }, 'now', true) },
    release: async ids => { for (const m of task.team!.members) if (ids.includes(m.id)) m.state = 'released' },
    live: () => false, tokensLeft: async () => 100_000, personSaid: () => ASK, later: async () => undefined, attach: async () => false,
  }
  const back = JSON.parse(await assignTool(paths, host, () => undefined).run({ wait: true, to: [{ who: '솔', brief: '오븐 빵집 새 메뉴 알아봐', topic: '오븐' }] }, { task: ASK })) as Handed
  expect(back.reports.map(r => [r.who, r.part, r.result])).toEqual([['솔', '오븐', `밤식빵이 새로 나왔어요. ${OVEN}`]])
  expect(task.team!.members.map(m => m.id)).toEqual(['m1', 'm2'])
  expect(core).not.toHaveProperty('turnHelpers')
})

test('a summary the writer shaped as a list is still the writer\'s: it is returned as written and the host\'s own summary is not used', async () => {
  const { paths, bots, now } = await week()
  const listed = '- 솔: 동네 빵집 새 메뉴 조사\n- 별: 산악회 모임 장소 고르기'
  const { write, calls } = writer([listed])
  expect(await teamSummary(paths, { bots, message: WEEK_ASK, now, write })).toBe(listed)
  expect(calls).toHaveLength(1)
  expect(calls[0]).not.toContain('Judge meaning only')
})

test('round 2 (finding 1): no repair is ever asked for, so none can be shown without a verdict: the writer is called once whatever it wrote', async () => {
  setReportLog(line => logged.push(line))
  const { paths, bots, now } = await week()
  const odd = '솔과 별이 2026-11-16에 일했어요. https://oven.example/news'
  const { write, calls } = writer([odd, '고친 글'])
  expect(await teamSummary(paths, { bots, message: WEEK_ASK, now, write })).toBe(odd)
  expect(calls).toHaveLength(1)
  expect(logged.join('\n')).not.toMatch(/repaired|refused/)
  for (const gone of ['checkedWrite', 'repairedWrite', 'readProblems', 'checkPrompt']) expect(core).not.toHaveProperty(gone)
})

test('round 2 (finding 2): the lead\'s comparison table and its links stand as written, and reshaping a reply is ruled in the prompt, not by a host rewrite', async () => {
  const draft = `두 곳 새 메뉴 비교예요.\n\n| 빵집 | 새 메뉴 | 출처 |\n|---|---|---|\n| 오븐 | 밤식빵 | [오븐 소식](${OVEN}) |\n| 도우 | 무화과 깜빠뉴 | [도우 게시판](${DOUGH}) |`
  expect(await posted(draft, '오븐이랑 도우 새 메뉴 표로 비교해줘')).toBe(draft)
  expect(COLLEAGUE_CORE_RULE).toContain('write that reply again in the asked form with every fact and every constraint of the original ask kept')
  expect(core).not.toHaveProperty('keepsForm')
})

test('round 3: a compared subject and the source beside it stay where the lead put them: every row of the posted table is the row it wrote', async () => {
  const rows = [`| 오븐 | 밤식빵 4,500원 | [오븐 소식](${OVEN}) |`, `| 크러스트 | 소금빵 3,200원 | [공지](${CRUST}) |`, `| 도우 | 무화과 깜빠뉴 7,000원 | [도우 게시판](${DOUGH}) |`]
  const draft = ['세 곳 값을 나란히 놓았어요.', '', '| 빵집 | 값 | 출처 |', '|---|---|---|', ...rows].join('\n')
  const out = await posted(draft, '세 빵집 새 메뉴 값 비교해줘')
  expect(out.split('\n').slice(4)).toEqual(rows)
  expect(out).toBe(draft)
})
