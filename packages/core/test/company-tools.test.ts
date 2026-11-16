import { expect, test, vi } from 'vitest'
import { loadBotMemory, recordFacts } from '../src/bot-memory.js'
import { appendBotTurn, createBot, loadArchivedBots, loadBots, readBotTranscript } from '../src/bots.js'
import { companyNote, companyStatus, companyStatusTool, isAssignAsk, isCompanyAsk, isStatusAsk, staffTool } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { readSidebarLayout } from '../src/sidebar-layout.js'
import { MEMBER_BLOCKED } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

async function company() {
  const paths = await initVault(await tmpVaultRoot('company-tools'), { git: false })
  const chief = await createBot(paths, { name: '비서실장' })
  const changed = vi.fn()
  const tool = staffTool(paths, changed)
  const run = (args: Record<string, unknown>) => tool.run(args, { task: '' })
  const named = async (name: string) => (await loadBots(paths)).find(bot => bot.name === name)
  return { paths, chief, changed, tool, run, named }
}

test('hiring makes an employee with a job title and a role, and says so in one Korean line', async () => {
  const { run, named, changed, tool } = await company()
  expect(await run({ hire: [{ name: '김대리', title: '리서치 담당', role: '자료를 찾아 출처와 함께 정리한다' }] })).toBe('김대리를 리서치 담당으로 뽑았어요.')
  const kim = (await named('김대리'))!
  expect(kim).toMatchObject({ label: '리서치 담당', purpose: '자료를 찾아 출처와 함께 정리한다' })
  expect(kim.primary).toBeUndefined()
  expect(changed).toHaveBeenCalledTimes(1)
  // Its reply is the answer, and a hidden team member can never manage the staff.
  expect(tool.closes).toBe(true)
  expect(MEMBER_BLOCKED.test('staff')).toBe(true)
  expect(MEMBER_BLOCKED.test('company_status')).toBe(true)
})

test('one call makes a team, hires into it and moves an existing employee in', async () => {
  const { paths, run, named } = await company()
  await run({ hire: [{ name: '김대리', title: '리서치 담당' }] })
  const said = await run({ hire: [{ name: '박사원', title: '카피 담당' }], team: [{ name: '마케팅팀', members: ['김대리', '박사원'] }] })
  expect(said).toBe('박사원을 카피 담당으로 뽑았어요.\n마케팅팀을 만들고 김대리, 박사원을 넣었어요.')
  const bots = await loadBots(paths), layout = await readSidebarLayout(paths, { chat: bots.map(bot => bot.id) })
  const folder = layout.chat.folders.find(one => one.name === '마케팅팀')!
  const inTeam = layout.chat.items.filter(item => item.folder === folder.id).map(item => item.id)
  expect(inTeam.sort()).toEqual([(await named('김대리'))!.id, (await named('박사원'))!.id].sort())
  expect((await named('박사원'))!.label).toBe('카피 담당')
  // A second call with the same team name reuses the folder.
  expect(await run({ hire: [{ name: '이과장', title: '영업 담당', team: '마케팅팀' }] })).toBe('이과장을 영업 담당으로 뽑았어요.\n마케팅팀에 이과장을 넣었어요.')
  expect((await readSidebarLayout(paths, { chat: (await loadBots(paths)).map(bot => bot.id) })).chat.folders.filter(one => one.name === '마케팅팀')).toHaveLength(1)
})

test('letting go archives (memory and transcript kept, restorable) and a promotion keeps id, memory and role', async () => {
  const { paths, run, named } = await company()
  await run({ hire: [{ name: '김대리', title: '리서치 담당', role: '조사한다' }, { name: '박사원', title: '카피 담당' }] })
  const kim = (await named('김대리'))!, park = (await named('박사원'))!
  await recordFacts(paths, kim.id, ['2026-11-16: 노션 신기능 조사를 마쳤다'])
  await recordFacts(paths, park.id, ['2026-11-16: 홍보 문구 3개를 썼다'])
  await appendBotTurn(paths, park.id, { role: 'assistant', text: '문구 3개입니다', at: new Date().toISOString() })

  expect(await run({ fire: ['박사원'], rename: [{ who: '김대리', name: '김과장' }] })).toBe('박사원을 내보냈어요. 기록은 남겨 뒀으니 다시 부르면 돌아와요.\n김대리는 이제 김과장이에요.')
  expect(await named('박사원')).toBeUndefined()
  expect(await named('김대리')).toBeUndefined()
  expect(await named('김과장')).toMatchObject({ id: kim.id, label: '리서치 담당', purpose: '조사한다' })
  expect((await loadBotMemory(paths, kim.id)).facts.map(fact => fact.text).join()).toContain('노션')
  expect((await loadArchivedBots(paths)).map(bot => bot.id)).toEqual([park.id])
  expect((await loadBotMemory(paths, park.id)).facts).toHaveLength(1)
  expect(await readBotTranscript(paths, park.id)).toHaveLength(1)

  // A fresh hire under a let-go name is refused with the way back; the way back restores the same employee.
  expect(await run({ hire: [{ name: '박사원', title: '카피 담당' }] })).toContain('다시 불러와')
  expect(await run({ rehire: ['박사원'] })).toBe('박사원이 돌아왔어요.')
  expect(await named('박사원')).toMatchObject({ id: park.id, label: '카피 담당' })
  expect(await loadArchivedBots(paths)).toEqual([])
})

test('a taken name, an unknown name and firing the chief of staff are refused in Korean and change nothing', async () => {
  const { paths, run, changed } = await company()
  await run({ hire: [{ name: '김대리', title: '리서치 담당' }] })
  const before = JSON.stringify(await loadBots(paths))
  expect(await run({ hire: [{ name: '김대리', title: '영업 담당' }, { name: '최주임', title: '디자인 담당' }] })).toBe('김대리라는 이름은 이미 쓰고 있어요. 다른 이름을 알려 주세요.')
  expect(await run({ fire: ['비서실장'] })).toBe('비서실장은 내보낼 수 없어요.')
  expect(await run({ fire: ['박사원'], rename: [{ who: '김대리', name: '비서실장' }] })).toBe('박사원이라는 직원은 없어요.\n비서실장이라는 이름은 이미 쓰고 있어요. 다른 이름을 알려 주세요.')
  expect(await run({ team: [{ name: '마케팅팀', members: ['없는사람'] }] })).toBe('없는사람이라는 직원은 없어요.')
  expect(JSON.stringify(await loadBots(paths))).toBe(before)
  expect((await readSidebarLayout(paths, { chat: (await loadBots(paths)).map(bot => bot.id) })).chat.folders).toEqual([])
  expect(changed).toHaveBeenCalledTimes(1)
  await expect(run({})).rejects.toThrow('nothing to do')
  await expect(run({ hire: [{ name: '최주임' }] })).rejects.toThrow('job title')
})

const task = (over: Partial<DelegatedTask>): DelegatedTask => ({ id: 't', goal: '', botId: '', state: 'done', turns: 1, createdAt: '2026-11-16T01:00:00.000Z', updatedAt: '2026-11-16T01:00:00.000Z', approvals: [], log: [], ...over })
const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: 'r', brief: '', state: 'working', sessionKey: 'k', hiredAt: '2026-11-16T01:00:00.000Z', ...over })

test('status is one Korean line per employee from stored tasks: working, waiting, or idle with the last job', async () => {
  const { paths, run, chief } = await company()
  expect(companyStatus(await loadBots(paths), [])).toContain('아직 직원이 없어요')
  await run({ hire: [{ name: '김대리', title: '리서치 담당' }, { name: '박사원', title: '카피 담당' }, { name: '이과장', title: '영업 담당' }, { name: '최주임', title: '디자인 담당' }] })
  await createBot(paths, { name: '그냥 대화' })
  const bots = await loadBots(paths), id = (name: string) => bots.find(bot => bot.name === name)!.id
  const tasks = [
    task({ id: 'a', botId: id('김대리'), state: 'running', goal: '다음 달 서울 IT 행사 일정 정리' }),
    task({ id: 'b', botId: id('박사원'), state: 'done', goal: '옛 일', updatedAt: '2026-11-15T01:00:00.000Z' }),
    task({ id: 'c', botId: id('박사원'), state: 'done', goal: '홍보 문구 3개' }),
    // Working as a member of the chief of staff's task.
    task({ id: 'd', botId: chief.id, state: 'running', goal: '경쟁사 조사', team: { members: [member({ botId: id('이과장'), brief: '리니어 신기능 조사' })], hires: 1, maxHires: 8, maxDepth: 3, big: false } }),
    task({ id: 'e', botId: id('최주임'), state: 'waiting', goal: '로고 시안' }),
  ]
  expect(companyStatus(bots, tasks, bot => bot === id('김대리') ? 'search_web: 서울 IT 행사' : undefined).split('\n')).toEqual([
    '- 김대리 (리서치 담당) — 일하는 중: 다음 달 서울 IT 행사 일정 정리 · search_web: 서울 IT 행사',
    '- 박사원 (카피 담당) — 쉬는 중 · 마지막 일: 홍보 문구 3개',
    '- 이과장 (영업 담당) — 일하는 중: 리니어 신기능 조사',
    '- 최주임 (디자인 담당) — 답을 기다리는 중: 로고 시안',
  ])
  const tool = companyStatusTool(paths)
  expect(tool.closes).toBe(true)
  expect(await tool.run({}, { task: '' })).toContain('- 김대리 (리서치 담당) — 쉬는 중')
})

test('only a bare status question skips the model; staff messages take the company lane', () => {
  for (const ask of ['다들 뭐하고 있어?', '다들 뭐해', '직원들 지금 뭐 하고 있어요?', '지금 누가 뭐 해?', '현황', 'status', "What's everyone doing?"]) expect(isStatusAsk(ask), ask).toBe(true)
  for (const ask of ['다들 뭐하고 있는지 표로 정리해서 메일로 보내줘', '김대리 뭐해?', '현황 보고서 써줘', '뭐해?']) expect(isStatusAsk(ask), ask).toBe(false)
  expect(isCompanyAsk('김대리 하나 뽑아줘. 리서치 담당이야', [], true)).toBe(true)
  expect(isCompanyAsk('박사원 내보내고 김대리는 김과장으로 승진시켜', ['김대리', '박사원'], true)).toBe(true)
  expect(isCompanyAsk('김과장 무슨 일 하는 사람이야?', ['김과장'], false)).toBe(true)
  // Hiring is the chief of staff's alone, and an ordinary or long message stays on the full lead.
  expect(isCompanyAsk('사람 하나 뽑아줘', [], false)).toBe(false)
  expect(isCompanyAsk('오늘 날씨 어때?', ['김과장'], true)).toBe(false)
  expect(isCompanyAsk(`김과장 ${'가'.repeat(200)}`, ['김과장'], true)).toBe(false)
  const known = ['김대리', '박사원', '김과장', '마케팅팀']
  for (const ask of ['마케팅팀 만들고 김대리랑 새로 박사원 뽑아서 넣어줘. 박사원은 카피 담당', '박사원 다시 불러와', '김대리 마케팅팀으로 옮겨줘', '김대리 뭐해?', '김대리 지금 뭐 하고 있어?', '마케팅팀 누구 있어?', '김과장 담당이 뭐야?', '직원 누구 있어?', '디자인팀 하나 만들어줘', '김대리 이름을 김프로로 바꿔줘'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(true)
  // Work that only names an employee or a team needs the full tool set: it never takes the lane.
  for (const ask of ['김대리가 만든 엑셀 고쳐줘', '마케팅팀 자료 PPT로 만들어줘', '이거 김대리한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '김대리 조사 끝나면 박사원한테 넘겨서 홍보 문구 3개 뽑게 해', '매주 월요일 아침 9시에 마케팅팀 주간보고 올려', '마케팅팀 이번 주 한 일 요약해', '홍보 문구 3개 뽑아줘', '김대리 로고 시안 뽑아줘', '과장된 표현만 뽑아줘', '이 표 마케팅팀에 넣어줘', '김대리가 쓴 글 좀 봐줘', '직원 교육 자료 만들어줘', '김대리 뭐해? 그리고 어제 그 파일도 열어줘'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(false)
})

test('the prompt note lists the roster and gives a named employee\'s memory and finished work', async () => {
  const { paths, run } = await company()
  expect(await companyNote(paths, { bots: await loadBots(paths), message: '안녕', chief: false })).toBe('')
  await run({ hire: [{ name: '김과장', title: '리서치 담당', role: '조사한다' }, { name: '박사원', title: '카피 담당' }] })
  const bots = await loadBots(paths), kim = bots.find(bot => bot.name === '김과장')!
  await recordFacts(paths, kim.id, ['2026-11-16: 노션 신기능 조사를 마쳤다'])
  const note = await companyNote(paths, { bots, message: '김과장 무슨 일 하는 사람이야?', chief: false, teams: new Map([[kim.id, '마케팅팀']]), tasks: [task({ botId: kim.id, goal: '다음 달 서울 IT 행사 일정 정리' })] })
  expect(note).toContain('- 김과장 — 리서치 담당 (team 마케팅팀). Role: 조사한다')
  expect(note).toContain('노션 신기능 조사')
  expect(note).toContain('2026-11-16: 다음 달 서울 IT 행사 일정 정리')
  expect(note).toContain('- 박사원 — 카피 담당')
  expect(note).not.toContain('What 박사원 remembers')
  expect(note).not.toContain('ONE staff call')
  expect(await companyNote(paths, { bots, message: '박사원 뭐하는 사람이야', chief: true })).toContain('ONE staff call')
})

// --- assign: handing work to employees ---
import { parseAsk } from '../src/ask.js'
import { assignTool, employeeNote, employeeWriteBack, handoffBrief, teamMemoryId, COMPANY_LANE_TOOLS, type AssignHost } from '../src/company-tools.js'
import { changeSidebarLayout } from '../src/sidebar-layout.js'
import { settleMember } from '../src/team-hire-tools.js'

async function office(work: (member: TeamMember) => { answer: string; asked?: boolean; error?: string } = member => ({ answer: `${member.role} 결과 https://example.com/${member.id}` })) {
  const c = await company()
  await c.run({ hire: [{ name: '김대리', title: '리서치 담당', role: '자료를 찾아 출처와 함께 정리한다' }, { name: '박사원', title: '카피 담당' }], team: [{ name: '마케팅팀', members: ['김대리', '박사원'] }] })
  const task = { id: 't1', goal: '경쟁사 조사', botId: c.chief.id, state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [] } as DelegatedTask
  const later: string[][] = [], attached: unknown[] = []
  let attach = false
  const finish = (ids: string[]) => { for (const m of task.team!.members.filter(one => ids.includes(one.id))) settleMember(m, work(m), '2026-11-16T01:00:00.000Z') }
  const host: AssignHost = {
    self: null, load: async () => task, change: async change => change(task),
    run: async ids => finish(ids),
    release: async ids => { for (const m of task.team!.members) if (ids.includes(m.id)) m.state = 'released' },
    live: () => false, tokensLeft: async () => 100_000, personSaid: () => '',
    later: async ids => { later.push(ids) },
    attach: async (botId, then) => { attached.push({ botId, then }); return attach },
  }
  const tool = assignTool(c.paths, host, c.changed)
  return { ...c, task, later, attached, finish, tool, assign: (args: Record<string, unknown>) => tool.run(args, { task: '' }), attachable: (on: boolean) => { attach = on } }
}

test('assign runs each employee as a member of their own, hires an unknown name on the spot and hands back attributed reports', async () => {
  const o = await office()
  const out = JSON.parse(await o.assign({ wait: true, to: [{ who: '김대리', brief: '노션 신기능' }, { who: '박사원', brief: '슬랙 신기능' }, { who: '이과장', brief: '리니어 신기능', title: '리서치 담당' }] }))
  const lee = (await o.named('이과장'))!
  expect(lee.label).toBe('리서치 담당')
  expect(out.hired).toEqual(['이과장은 리서치 담당으로 새로 뽑았어요.'])
  expect(out.reports.map((r: { who: string; state: string }) => [r.who, r.state])).toEqual([['김대리', 'done'], ['박사원', 'done'], ['이과장', 'done']])
  expect(out.reports[2].result).toContain('https://example.com/m3')
  // Each is the employee (botId), a fast lookup, and already accepted: the chief of staff needs no review round.
  expect(o.task.team!.members.map(m => [m.botId === (m.role === '이과장' ? lee.id : m.botId), m.lookup, m.state, m.review?.ok, m.background])).toEqual([[true, true, 'released', true, undefined], [true, true, 'released', true, undefined], [true, true, 'released', true, undefined]])
  expect(o.task.team!.members[0]!.botId).toBe((await o.named('김대리'))!.id)
  expect(typeof o.tool.closes === 'function' && [o.tool.closes({ wait: true }), o.tool.closes({ wait: false })]).toEqual([false, true])
  expect(MEMBER_BLOCKED.test('assign')).toBe(true)
  expect(COMPANY_LANE_TOOLS.has('assign')).toBe(true)
  expect(COMPANY_LANE_TOOLS.size).toBeLessThanOrEqual(16)
  // Handing work off takes the lane by its own matcher (isCompanyAsk leaves work sentences alone).
  for (const ask of ['이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 보고해. 김대리, 박사원, 이과장한테 나눠서 시켜', '이거 김대리한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '김대리 조사 끝나면 박사원한테 넘겨서 홍보 문구 3개 뽑게 해', '마케팅팀에게 맡겨줘', '민지한테 시켜'])
    expect(isAssignAsk(ask, ['김대리', '박사원', '민지', '마케팅팀']), ask).toBe(true)
  for (const ask of ['이거 나한테 맡겨', '엄마한테 메일 보내라고 시켜줘', '김대리한테 온 메일 보여줘', '피자 시켜줘', '김대리가 만든 엑셀 고쳐줘', `김대리한테 맡겨 ${'가'.repeat(200)}`])
    expect(isAssignAsk(ask, ['김대리', '박사원']), ask).toBe(false)
})

test('assign without waiting answers in one Korean line and leaves the work running in the background', async () => {
  const o = await office()
  expect(await o.assign({ wait: false, to: [{ who: '김대리', brief: '다음 달 서울 IT 행사 일정 정리' }] })).toBe('김대리한테 맡겼어요.')
  expect(o.later).toEqual([['m1']])
  expect(o.task.team!.members[0]).toMatchObject({ background: true, state: 'hired', role: '김대리' })
  expect(await o.assign({ wait: false, to: [{ who: '김대리', brief: '조사', then: { who: '박사원', brief: '홍보 문구 3개' } }] })).toBe('김대리한테 맡겼어요. 끝나면 박사원한테 넘길게요.')
  expect(o.task.team!.members[1]!.then).toEqual({ botId: (await o.named('박사원'))!.id, who: '박사원', brief: '홍보 문구 3개' })
})

test('a failed part is said as failed, and an employee who needs the person is asked up', async () => {
  const failing = await office(member => member.role === '박사원' ? { answer: '', error: 'no source' } : { answer: `${member.role} 결과` })
  const out = JSON.parse(await failing.assign({ wait: true, to: [{ who: '김대리', brief: 'a' }, { who: '박사원', brief: 'b' }] }))
  expect(out.reports.map((r: { state: string }) => r.state)).toEqual(['done', 'failed'])
  expect(failing.task.team!.members.every(m => m.state === 'released' && !!m.review)).toBe(true)
  const asking = await office(() => ({ answer: '어느 달인가요?', asked: true }))
  expect(parseAsk(await asking.assign({ wait: true, to: [{ who: '김대리', brief: 'a' }] }))?.question).toBe('김대리: 어느 달인가요?')
  expect(asking.task.team!.members[0]).toMatchObject({ state: 'waiting' })
})

test('a handoff with no new brief joins the job the employee is on, or takes their last finished result', async () => {
  const o = await office()
  const hand = { wait: true, to: [{ who: '김대리', then: { who: '박사원', brief: '홍보 문구 3개' } }] }
  // Nothing finished and nothing running: refused in Korean, nothing started.
  expect(await o.assign(hand)).toBe('김대리가 끝낸 일이 아직 없어서 넘길 게 없어요.')
  expect(o.task.team).toBeUndefined()
  o.attachable(true)
  expect(await o.assign(hand)).toBe('김대리 일이 끝나면 박사원한테 넘길게요.')
  expect(o.attached).toHaveLength(2)
  expect(o.task.team).toBeUndefined()
  // Finished earlier (in a task on record): 박사원 starts now with that result.
  o.attachable(false)
  const { createTask, updateTask } = await import('../src/delegated-tasks.js')
  const earlier = await createTask(o.paths, '행사 조사', o.chief.id)
  const kim = (await o.named('김대리'))!
  await updateTask(o.paths, earlier.id, t => { t.state = 'done'; t.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '김대리', brief: '행사', botId: kim.id, state: 'released', result: '11월 20일 서울 AI 서밋 https://example.com/summit', sessionKey: 's', hiredAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z' }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  const out = JSON.parse(await o.assign(hand))
  expect(out.reports.map((r: { who: string }) => r.who)).toEqual(['박사원'])
  expect(o.task.team!.members[0]!.brief).toBe(handoffBrief('홍보 문구 3개', '김대리', '11월 20일 서울 AI 서밋 https://example.com/summit'))
})

test('assign refuses a let-go employee and the chief of staff, and starts nothing', async () => {
  const o = await office()
  await o.run({ fire: ['박사원'] })
  expect(await o.assign({ wait: false, to: [{ who: '박사원', brief: 'a' }, { who: '비서실장', brief: 'b' }] })).toBe('박사원은 전에 내보낸 직원이에요. "박사원 다시 불러와"라고 하면 돌아와요.\n비서실장한테는 맡길 수 없어요. 직원 이름을 알려 주세요.')
  expect(o.task.team).toBeUndefined()
  expect(o.later).toEqual([])
})

test('a finished job is written to the employee\'s own conversation, their memory and their team\'s memory', async () => {
  const o = await office()
  const kim = (await o.named('김대리'))!
  const folder = (await readSidebarLayout(o.paths, { chat: (await loadBots(o.paths)).map(bot => bot.id) })).chat.items.find(item => item.id === kim.id)!.folder!
  await employeeWriteBack(o.paths, { botId: kim.id, brief: '노션 신기능 조사', result: '노션이 AI 회의록을 추가했습니다. https://notion.so/releases' }, new Date('2026-11-16T03:00:00.000Z'))
  expect((await readBotTranscript(o.paths, kim.id)).map(turn => [turn.role, turn.text])).toEqual([['user', '노션 신기능 조사'], ['assistant', '노션이 AI 회의록을 추가했습니다. https://notion.so/releases']])
  const line = '노션 신기능 조사 → 노션이 AI 회의록을 추가했습니다. https://notion.so/releases (김대리, 2026-11-16)'
  expect((await loadBotMemory(o.paths, kim.id)).facts.map(fact => fact.text)).toEqual([line])
  expect((await loadBotMemory(o.paths, teamMemoryId(folder))).facts.map(fact => fact.text)).toEqual([line])
  // A long result is cut to one memory line that still ends on who and when.
  await employeeWriteBack(o.paths, { botId: kim.id, brief: '슬랙 조사', result: '가'.repeat(400) }, new Date('2026-11-16T04:00:00.000Z'))
  const long = (await loadBotMemory(o.paths, kim.id)).facts[1]!.text
  expect(long.length).toBeLessThanOrEqual(160)
  expect(long.endsWith('(김대리, 2026-11-16)')).toBe(true)
  // The employee works as themselves: role and memory are in their persona.
  const note = await employeeNote(o.paths, kim.id, new Date('2026-11-16T05:00:00.000Z'))
  expect(note).toContain('You are 김대리, 리서치 담당')
  expect(note).toContain('자료를 찾아 출처와 함께 정리한다')
  expect(note).toContain('노션 신기능 조사 →')
  // An employee outside any team writes no team memory.
  await changeSidebarLayout(o.paths, { kind: 'chat', change: { action: 'move-item', id: kim.id, folder: null } }, { chat: (await loadBots(o.paths)).map(bot => bot.id) })
  await employeeWriteBack(o.paths, { botId: kim.id, brief: '리니어 조사', result: '결과' }, new Date('2026-11-16T06:00:00.000Z'))
  expect((await loadBotMemory(o.paths, teamMemoryId(folder))).facts).toHaveLength(2)
})
