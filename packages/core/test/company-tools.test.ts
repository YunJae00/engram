import { expect, test, vi } from 'vitest'
import { loadBotMemory, recordFacts } from '../src/bot-memory.js'
import { appendBotTurn, createBot, loadArchivedBots, loadBots, readBotTranscript } from '../src/bots.js'
import { companyNote, companyStatus, companyStatusTool, isCompanyAsk, isStatusAsk, staffTool } from '../src/company-tools.js'
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
