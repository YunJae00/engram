import { expect, test } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runComet } from '../src/agent-session.js'
import { CHOICE_RULE, COLLEAGUE_CORE_RULE, FILE_JOB_RULE } from '../src/prompt.js'
import { recordFacts } from '../src/bot-memory.js'
import { createBot, loadBots } from '../src/bots.js'
import { companyNote, employeesAnswer, handBacks, partOutcome, staffTool, TEAM_MEMORY } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

interface HandBack { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
async function lead(ask: string, draft: string, handed?: string): Promise<{ answer: string; jobs: ToolSessionJob[]; got: string[] }> {
  const jobs: ToolSessionJob[] = [], got: string[] = []
  const assign: AgentTool = { name: 'assign', description: 'hands parts to teammates', argsSchema: { type: 'object' }, run: async () => handed ?? '' }
  const engine = {
    id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () { yield { type: 'result', text: '' } },
    runTools: async (job: ToolSessionJob): Promise<ToolSessionResult> => {
      jobs.push(job)
      if (handed !== undefined) { const out = await job.tools.find(tool => tool.name === 'assign')!.run({ wait: true }); got.push(typeof out === 'string' ? out : out.text) }
      return { answer: draft }
    },
  } as unknown as Engine
  const result = await runComet({ engine, workdir: 'C:/tmp' as EngineCwd, tools: handed === undefined ? [] : [assign] }, ask, { guided: false })
  return { answer: result.answer, jobs, got }
}

const part = (id: string, role: string, brief: string, topic: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: new Date().toISOString() })
const reported = (m: TeamMember, words: string, url: string): TeamMember => {
  const one: TeamMember = { ...m }
  settleMember(one, { answer: `${words} ${url}`, sources: [url] }, new Date().toISOString(), true)
  return one
}
const A = 'https://a.example.com/central', B = 'https://b.example.com/haemalgeun', C = 'https://c.example.com/byeolbit'
const libraries = (): TeamMember[] => [
  reported(part('m1', '하은', '이번 주말 중앙도서관 운영 확인', '중앙도서관'), '중앙도서관은 이번 주말 휴관이에요.', A),
  reported(part('m2', '준', '이번 주말 해맑은도서관 운영 확인', '해맑은도서관'), '해맑은도서관은 토요일 오전 9시부터 정상 운영해요.', B),
  reported(part('m3', '소윤', '이번 주말 별빛도서관 운영 확인', '별빛도서관'), '별빛도서관은 이번 주말 휴관이에요.', C),
]
const ASK = '동네 도서관 세 곳 이번 주말에 여는지 나눠서 알아봐줘'
const body = `중앙도서관은 하은이 봤는데 휴관이에요. [a](${A})\n해맑은도서관은 준이 봤는데 토요일 오전 9시부터 열어요. [b](${B})\n별빛도서관은 소윤이 봤는데 휴관이에요. [c](${C})`

test('a merged answer whose lead contradicts a row is not rewritten: the lead model reads every teammate\'s own words and its draft is what the person gets', async () => {
  const members = libraries(), handed = handBacks(members)
  const draft = `세 곳 모두 이번 주말엔 문을 닫았어요.\n\n${body}`
  const { answer, jobs, got } = await lead(ASK, draft, handed)
  expect(answer).toBe(draft)
  expect(jobs).toHaveLength(1)
  expect(got).toEqual([handed])
  const back = JSON.parse(got[0]!) as HandBack
  expect(back.reports.map(one => [one.who, one.part, one.state])).toEqual([['하은', '중앙도서관', 'done'], ['준', '해맑은도서관', 'done'], ['소윤', '별빛도서관', 'done']])
  expect(back.reports[1]!.result).toBe(`해맑은도서관은 토요일 오전 9시부터 정상 운영해요. ${B}`)
  expect(back.reports.map(one => one.sources)).toEqual([[A], [B], [C]])
  expect(jobs[0]!.prompt).toContain(ASK)
})

test('a question back to the person stays in the draft as written; the hand-back note is what asks for no closing question', async () => {
  const members = libraries()
  const asking = `${body}\n\n별빛도서관은 다시 찾아볼까요, 아니면 다른 도서관 이름을 알려주실래요?`
  const { answer, jobs, got } = await lead(ASK, asking, handBacks(members))
  expect(answer).toBe(asking)
  expect(jobs).toHaveLength(1)
  const note = (JSON.parse(got[0]!) as HandBack).note
  expect(note).toContain('No sections per agent, no closing offer or question.')
  expect(note).toContain('Give the person ONE merged answer in their language that reads as the teammates talking')
})

test('no checker is waited for: the turn is over when the one model call is, and the text is unchanged', async () => {
  const draft = `해맑은도서관만 열어요.\n\n${body}`
  const began = Date.now()
  const { answer, jobs } = await lead(ASK, draft, handBacks(libraries()))
  expect(Date.now() - began).toBeLessThan(1000)
  expect(answer).toBe(draft)
  expect(jobs).toHaveLength(1)
})

test('no verdict routes the draft: whatever it says, it is delivered, and the check is not part of the package', async () => {
  for (const draft of ['초안이에요.', '빵집은 화요일에 쉬어요. 아닌가요, 수요일일 수도 있어요.', '어느 쪽으로 정리할까요?\n1. 표\n2. 목록']) {
    const { answer, jobs } = await lead('동네 빵집 쉬는 날 알려줘', draft)
    expect(answer, draft).toBe(draft)
    expect(jobs, draft).toHaveLength(1)
  }
})

test('what the four problem kinds looked for is asked of the writer in its own prompt, and a reshaped reply keeps its facts by rule', async () => {
  const { jobs } = await lead('빵집 공지 요약해줘', '화요일에 쉬어요.')
  const system = jobs[0]!.system
  expect(system).toContain('holds only what is in it: no added item, number, owner, date or question.')
  expect(system).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished.')
  expect(system).toContain(CHOICE_RULE)
  expect(system).toContain(FILE_JOB_RULE)
  expect(COLLEAGUE_CORE_RULE).toContain('with every fact and constraint kept')
})

test('what the team did this week: the lane note keeps a teammate who has left in the record only and a renamed one under the new name, and the lane model\'s text is returned as written', async () => {
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
  const note = await companyNote(paths, { bots, tasks: [task], message: ask, chief: true, now })
  const [team, record] = note.split('The team\'s record') as [string, string]
  expect(record).toContain('이번 주 카페 후보 조사 → 성수동 카페 두 곳을 찾았어요 (하은, 11월 16일)')
  expect(record).toContain('이번 주 회의실 예약 정리 → 목요일 오후로 잡았어요 (준, 11월 17일)')
  expect(record).not.toContain('준호')
  expect(team).toContain('- 준 — 정리 담당')
  expect(team).not.toContain('하은')
  const { answer, jobs } = await lead(ask, draft)
  expect(answer).toBe(draft)
  expect(jobs).toHaveLength(1)
})

test('a nothing-new part\'s latest change reaches the lead in the teammate\'s own words, whole, and the part counts as found from its words', () => {
  const list = '그림판 앱에 레이어 묶기, 자동 배경 지우기, 새 붓 세트, 공유 링크 권한, 팀 폴더 기능이 들어갔어요.'
  const said = `이번 주엔 새로 나온 게 없어요. 가장 최근엔 10월 2일에 ${list}`
  const m = reported(part('m1', '하은', '이번 주 그림판 앱 신기능 조사', '그림판'), said, 'https://paint.example.com/notes')
  const back = JSON.parse(handBacks([m])) as HandBack
  expect(back.reports).toHaveLength(1)
  expect(back.reports[0]!.result).toBe(`${said} https://paint.example.com/notes`)
  expect(back.reports[0]!.result).toContain('팀 폴더 기능')
  expect(back.reports[0]!.sources).toEqual(['https://paint.example.com/notes'])
  expect(m.data).toBeUndefined()
  expect(partOutcome(m)).toBe('found')
})

test('a part that brought nothing is handed back with empty words and its own state, so the lead can say it; a lead claiming every part came back is still delivered as written', async () => {
  const empty: TeamMember = { ...part('m3', '소윤', '이번 주말 별빛도서관 운영 확인', '별빛도서관'), state: 'failed', result: 'Failed: it ended without an answer.' }
  const members = [libraries()[0]!, libraries()[1]!, empty]
  const two = `중앙도서관은 하은이 봤는데 휴관이에요. [a](${A})\n해맑은도서관은 준이 봤는데 토요일 오전 9시부터 열어요. [b](${B})`
  const draft = `세 곳 다 확인했는데 해맑은도서관만 열어요.\n\n${two}`
  const { answer, jobs, got } = await lead(ASK, draft, handBacks(members))
  expect(answer).toBe(draft)
  expect(jobs).toHaveLength(1)
  const back = JSON.parse(got[0]!) as HandBack
  expect(back.reports[2]).toEqual({ who: '소윤', part: '별빛도서관', state: 'failed', result: 'Failed: it ended without an answer.' })
  expect(members.map(partOutcome)).toEqual(['found', 'found', 'unfinished'])
  expect(back.note).toContain('Say plainly which part failed or is missing.')
})

test('work that comes back later reaches the lead step as the same hand-back and nothing else; with nobody to report there is none', () => {
  const at = new Date().toISOString()
  const members = libraries().map(m => ({ ...m, background: true as const }))
  const task: DelegatedTask = { id: 't', goal: ASK, botId: 'chief', state: 'done', turns: 1, createdAt: at, updatedAt: at, approvals: [], log: [], team: { members, hires: 3, maxHires: 8, maxDepth: 3, big: false } }
  expect(employeesAnswer(task)).toBe(handBacks(members))
  const back = JSON.parse(employeesAnswer(task)!) as HandBack
  expect(back.reports.map(one => one.result)).toEqual(members.map(m => m.result))
  expect(employeesAnswer({ ...task, team: { ...task.team!, members: [] } })).toBeUndefined()
  expect(employeesAnswer(undefined)).toBeUndefined()
  expect(employeesAnswer({ ...task, team: { ...task.team!, posted: members.map(m => m.id) } })).toBeUndefined()
})
