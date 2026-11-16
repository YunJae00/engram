import { expect, test, vi } from 'vitest'
import { loadBotMemory, recordFacts } from '../src/bot-memory.js'
import { appendBotTurn, createBot, loadArchivedBots, loadBots, readBotTranscript } from '../src/bots.js'
import { companyNote, companyStatus, companyStatusTool, isAssignAsk, isCompanyAsk, isDutyAsk, isOutsideAsk, plainHandoff, isStatusAsk, isTeamWorkAsk, staffTool, takesCompanyLane } from '../src/company-tools.js'
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

// B2 r3: "사람 사진 3장 뽑아줘" took the lane ("사람" read as a person to hire, "뽑아" as hiring) and lost the image tools.
test('picking or making things is never a hire: a hire needs a staff word and no artifact', () => {
  const known = ['김대리', '박사원', '김과장', '마케팅팀']
  for (const ask of ['사람 사진 3장 뽑아줘', '직원 사진 3장 뽑아줘', '담당자 이름 뽑아줘', '팀원 후보 5개 뽑아줘', '인턴 채용 공고 문구 뽑아줘', '이미지 2개 뽑아줘', '핵심만 세 줄 뽑아줘', '사람 하나 뽑아줘', '대리 운전 번호 뽑아줘', '직원 명단 표 한 장 뽑아줘', '로고 시안 4개 뽑아줘', '3개 뽑아줘', '10장 뽑아줘', '김대리 사진 몇 장 뽑아줘', '직원 소개 문구 뽑아줘', '사람 그림 뽑아줘'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(false)
  for (const ask of ['김대리 하나 뽑아줘. 리서치 담당이야', '직원 두 명 뽑아줘', '인턴 한 명 채용해줘. 영업 담당', '디자인 담당 팀원 뽑아줘', '마케팅팀 만들고 김대리랑 새로 박사원 뽑아서 넣어줘. 박사원은 카피 담당', '이과장 뽑아줘'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(true)
})

// c1fix r1: C5's "김대리한테 맡겼어요" came 5.9 s in, after a model round that only copied the sentence into an assign call.
test('a plain hand-off to one employee on staff is the assign call itself; anything more is left to the model', () => {
  const staff = ['김대리', '박사원']
  // The same arguments team-runner.test.ts gives assign for "김대리한테 맡겼어요.".
  expect(plainHandoff('이거 김대리한테 맡겨: 다음 달 서울 IT 행사 일정 정리', staff)).toEqual({ wait: false, to: [{ who: '김대리', brief: '다음 달 서울 IT 행사 일정 정리' }] })
  expect(plainHandoff('박사원에게 시켜 줘： 경쟁사 가격 조사', staff)?.to).toEqual([{ who: '박사원', brief: '경쟁사 가격 조사' }])
  for (const ask of [
    '이거 이과장한테 맡겨: 행사 일정 정리', // not on staff: the model's call hires
    '김대리한테 맡겨', '김대리한테 행사 일정 정리 맡겨', // no brief of its own after a colon
    '김대리한테 맡겨: 행사 조사하고 끝나면 박사원한테 넘겨', '김대리랑 박사원한테 맡겨: 행사 조사', // a handoff, two people
    '김대리한테 맡겨: 행사 일정 조사해서 보고해', '김대리한테 맡겨: 행사 일정표 파일로 만들어', // a report in this answer, a file to make
    '김대리한테 맡겨: 행사 일정 정리해서 슬랙에 올려', '김대리한테 맡겨: 거래처에 메일 보내', // goes outside: never the lane
  ]) expect(plainHandoff(ask, staff), ask).toBeUndefined()
})

// B3 r2: "마케팅팀 이번 주 한 일 요약해서 슬랙에 올려" took the lane, which has no posting tool and so no approval gate to reach.
test('anything that goes outside or names an app keeps the normal path, also on a scheduled run and when it also sets a regular time', () => {
  const who = { staff: ['김대리', '박사원'], gone: ['이과장'], teams: ['마케팅팀'], chief: true }
  for (const ask of ['마케팅팀 이번 주 한 일 요약해서 슬랙에 올려', '마케팅팀 주간보고 메일로 보내', '마케팅팀 이번 주 한 일 요약해서 노션에 올려줘', '김대리한테 시켜서 거래처에 문자 보내', '김대리 뭐하는지 카톡으로 알려줘', '마케팅팀 성과 요약해서 팀 채널에 공유해']) {
    expect(isOutsideAsk(ask), ask).toBe(true)
    expect(takesCompanyLane(ask, who), ask).toBe(false)
    expect(takesCompanyLane(ask, { ...who, scheduled: true }), `scheduled: ${ask}`).toBe(false)
  }
  // B3 r3: a regular time does not bring an outside post into the lane, which could keep the schedule but never post now. The normal path has both tools.
  for (const ask of ['지금 마케팅팀 주간보고 슬랙에 올리고 매주 월요일 9시에도 올려', '매주 월요일 아침 9시에 마케팅팀 주간보고 슬랙에 올려', '마케팅팀 주간보고 지금 메일로 보내고 매주 금요일 오후 5시에도 보내줘', '매일 아침 9시에 김대리 한 일 정리해서 노션에 올리고 오늘 것도 바로 올려', '오늘 실적 팀 채널에 공유하고 매주 월요일 10시마다 공유해', '매달 1일 오전 9시에 거래처에 문자 발송하고 이번 달 건 지금 발송해']) {
    expect(isDutyAsk(ask), ask).toBe(true)
    expect(takesCompanyLane(ask, who), ask).toBe(false)
    expect(takesCompanyLane(ask, { ...who, scheduled: true }), `scheduled: ${ask}`).toBe(false)
  }
  // Nothing outside: the lane still takes them, a scheduled report in the thread included.
  for (const ask of ['마케팅팀 이번 주 한 일 요약해', '마케팅팀 주간보고 올려', '이거 김대리한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '김대리 뭐해?', '이과장 다시 불러와']) {
    expect(takesCompanyLane(ask, who), ask).toBe(true)
    expect(takesCompanyLane(ask, { ...who, scheduled: true }), `scheduled: ${ask}`).toBe(true)
  }
  expect(takesCompanyLane('마케팅팀 이번 주 한 일 요약해', { ...who, chief: false })).toBe(false)
  // The BAR's own company sentences keep the lane: an app named as a subject (C3) or "내보내" (C8) is not something going outside.
  const all = { staff: ['김대리', '박사원', '이과장'], teams: ['마케팅팀'], chief: true }
  for (const ask of ['김대리 하나 뽑아줘. 리서치 담당이야', '마케팅팀 만들고 김대리랑 새로 박사원 뽑아서 넣어줘. 박사원은 카피 담당', '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 보고해. 김대리, 박사원, 이과장한테 나눠서 시켜', '이거 김대리한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '김대리 조사 끝나면 박사원한테 넘겨서 홍보 문구 3개 뽑게 해', '매주 월요일 아침 9시에 마케팅팀 주간보고 올려', '박사원 내보내고 김대리는 김과장으로 승진시켜', '이과장 무슨 일 하는 사람이야?', '마케팅팀 이번 주 한 일 요약해', '슬랙에서 뭐 나왔는지 김대리한테 조사 시켜'])
    expect(takesCompanyLane(ask, all), ask).toBe(true)
  expect(takesCompanyLane('오늘 날씨 어때?', who)).toBe(false)
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

test('a duty or a team-report sentence takes the lane by its own matcher; work on files does not', () => {
  for (const ask of ['매주 월요일 아침 9시에 마케팅팀 주간보고 올려', '평일마다 오후 6시에 김대리 업무 정리해서 알려줘', '내 일정 뭐 있어?', '일정 뭐 있어', '정기 보고 뭐 있어?'])
    expect(isDutyAsk(ask), ask).toBe(true)
  for (const ask of ['매주 하는 회의가 너무 많아', '오늘 일정 정리해서 엑셀로 만들어줘', '내 일정에 치과 예약 넣어줘', '다음 달 서울 IT 행사 일정 정리', `매주 월요일 9시에 ${'가'.repeat(200)}`])
    expect(isDutyAsk(ask), ask).toBe(false)
  for (const ask of ['마케팅팀 이번 주 한 일 요약해', '마케팅팀 주간보고 올리기', '마케팅팀 지난주에 뭐 했어?'])
    expect(isTeamWorkAsk(ask, ['마케팅팀']), ask).toBe(true)
  for (const ask of ['마케팅팀 자료 PPT로 만들어줘', '마케팅팀 주간보고서 엑셀로 만들어줘', '이번 주 한 일 요약해', '개발팀 이번 주 한 일 요약해', '이 표 마케팅팀에 넣어줘'])
    expect(isTeamWorkAsk(ask, ['마케팅팀']), ask).toBe(false)
})

test('a team named in the message brings its memory, written by its members\' finished jobs, into the prompt note', async () => {
  const { paths, run } = await company()
  await run({ hire: [{ name: '김대리', title: '리서치 담당' }, { name: '박사원', title: '카피 담당' }], team: [{ name: '마케팅팀', members: ['김대리', '박사원'] }] })
  const bots = await loadBots(paths), kim = bots.find(bot => bot.name === '김대리')!
  const folder = (await readSidebarLayout(paths, { chat: bots.map(bot => bot.id) })).chat.folders.find(one => one.name === '마케팅팀')!
  const teamIds = new Map([[folder.name, folder.id]])
  expect(await companyNote(paths, { bots, message: '마케팅팀 이번 주 한 일 요약해', chief: true, teamIds })).toContain('Team 마케팅팀 has no finished work on record yet')
  await employeeWriteBack(paths, { botId: kim.id, brief: '노션 신기능 조사', result: '노션이 AI 회의록을 냈다 https://example.com/notion' }, new Date('2026-11-16T03:00:00Z'))
  const note = await companyNote(paths, { bots, message: '마케팅팀 이번 주 한 일 요약해', chief: true, teamIds, now: new Date('2026-11-16T04:00:00Z') })
  expect(note).toContain('Team 마케팅팀\'s record')
  expect(note).toContain('노션 신기능 조사 → 노션이 AI 회의록을 냈다 https://example.com/notion (김대리, 2026-11-16)')
  expect(note).toContain('schedule add')
  // Not named, not loaded.
  expect(await companyNote(paths, { bots, message: '김대리 뭐해?', chief: true, teamIds })).not.toContain('Team 마케팅팀')
})

// --- assign: handing work to employees ---
import { parseAsk } from '../src/ask.js'
import { aboutEmployee, assignTool, employeeNote, employeeWriteBack, employeesReport, handedFrom, handoffBrief, mergedReport, plainHire, teamMemoryId, COMPANY_LANE_TOOLS, type AssignHost } from '../src/company-tools.js'
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
  // grokbar B7 (C3): parts that only look things up come back as the one merged answer, written by the host: one table, a row per
  // employee with their part, their name and their link. No model merges it (the call closes the turn).
  const said = await o.assign({ wait: true, to: [{ who: '김대리', brief: '노션 신기능', topic: '노션' }, { who: '박사원', brief: '슬랙 신기능', topic: '슬랙' }, { who: '이과장', brief: '리니어 신기능', topic: '리니어', title: '리서치 담당' }] })
  const lee = (await o.named('이과장'))!
  expect(lee.label).toBe('리서치 담당')
  expect(said).toBe([
    '이과장은 리서치 담당으로 새로 뽑았어요.', '김대리, 박사원, 이과장 보고예요.', '', '| 맡은 일 (담당) | 내용 | 출처 |', '|---|---|---|',
    '| 노션 (김대리) | 김대리 결과 | [example.com](https://example.com/m1) |', '| 슬랙 (박사원) | 박사원 결과 | [example.com](https://example.com/m2) |', '| 리니어 (이과장) | 이과장 결과 | [example.com](https://example.com/m3) |',
  ].join('\n'))
  // Each is the employee (botId), a fast lookup, and already accepted: the chief of staff needs no review round.
  expect(o.task.team!.members.map(m => [m.botId === (m.role === '이과장' ? lee.id : m.botId), m.lookup, m.state, m.review?.ok, m.background])).toEqual([[true, true, 'released', true, undefined], [true, true, 'released', true, undefined], [true, true, 'released', true, undefined]])
  expect(o.task.team!.members[0]!.botId).toBe((await o.named('김대리'))!.id)
  expect(typeof o.tool.closes === 'function' && [o.tool.closes({ wait: true, to: [{ who: '김대리', brief: 'a' }] }), o.tool.closes({ wait: true, to: [{ who: '김대리', brief: 'a', make: true }] }), o.tool.closes({ wait: false })]).toEqual([true, false, true])
  // A part that makes something still comes back as reports for the chief of staff to merge, with the pages each one read.
  const making = await office()
  const out = JSON.parse(await making.assign({ wait: true, to: [{ who: '김대리', brief: '노션 신기능 표로 저장', make: true }, { who: '박사원', brief: '슬랙 신기능' }] }))
  expect(out.reports.map((r: { who: string; state: string }) => [r.who, r.state])).toEqual([['김대리', 'done'], ['박사원', 'done']])
  expect(out.reports[1].result).toContain('https://example.com/m2')
  expect(out.note).toContain('ONE table')
  expect(out.note).toContain('markdown link')
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
  const out = await failing.assign({ wait: true, to: [{ who: '김대리', brief: 'a' }, { who: '박사원', brief: 'b' }] })
  // The missing part is said in its own row, never dropped and never the host's own failure note.
  expect(out.split('\n').slice(-2)).toEqual(['| 김대리 | 김대리 결과 | - |', '| 박사원 | 조사하지 못했어요. | - |'])
  expect(out).not.toMatch(/Failed|no source/)
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
  // grokbar B7 (C6): the report is 박사원's own result, then the facts it was made from, under whose they were and what that job was.
  expect(await o.assign(hand)).toBe('박사원 보고예요. 김대리한테 받은 내용으로 했어요.\n\n박사원 결과 https://example.com/m1\n\n김대리한테 받은 내용 (행사):\n11월 20일 서울 AI 서밋 https://example.com/summit')
  expect(o.task.team!.members[0]!.brief).toBe(handoffBrief('홍보 문구 3개', '김대리', '11월 20일 서울 AI 서밋 https://example.com/summit', '행사'))
  expect(handedFrom(o.task.team!.members[0]!.brief)).toEqual({ brief: '홍보 문구 3개', from: '김대리', job: '행사', result: '11월 20일 서울 AI 서밋 https://example.com/summit' })
  expect(handedFrom(handoffBrief('문구', '김대리', '결과'))).toEqual({ brief: '문구', from: '김대리', job: '', result: '결과' })
  expect(handedFrom('그냥 일')).toBeUndefined()
})

// B3 r2: the last result was taken from every stored task, so a result from another conversation could land in an employee's brief.
test('a handoff with no new brief never takes a result from another thread', async () => {
  const o = await office()
  const { createBot } = await import('../src/bots.js'), { createTask, updateTask } = await import('../src/delegated-tasks.js')
  const kim = (await o.named('김대리'))!, other = await createBot(o.paths, { name: '개인 메모' })
  const elsewhere = await createTask(o.paths, '사적인 일', other.id)
  await updateTask(o.paths, elsewhere.id, t => { t.state = 'done'; t.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '김대리', brief: '사적인 조사', botId: kim.id, state: 'released', result: '다른 대화의 비공개 결과', sessionKey: 's', hiredAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T09:00:00.000Z' }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  const hand = { wait: true, to: [{ who: '김대리', then: { who: '박사원', brief: '홍보 문구 3개' } }] }
  expect(await o.assign(hand)).toBe('김대리가 끝낸 일이 아직 없어서 넘길 게 없어요.')
  expect(o.task.team).toBeUndefined()
  // With an older result in this thread, that one is handed over, not the newer one from elsewhere.
  const here = await createTask(o.paths, '행사 조사', o.chief.id)
  await updateTask(o.paths, here.id, t => { t.state = 'done'; t.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '김대리', brief: '행사', botId: kim.id, state: 'released', result: '이 대화의 결과', sessionKey: 's', hiredAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z' }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  await o.assign(hand)
  expect(o.task.team!.members[0]!.brief).toBe(handoffBrief('홍보 문구 3개', '김대리', '이 대화의 결과', '행사'))
  expect(JSON.stringify(o.task.team)).not.toContain('비공개')
})

// B3 r2: the pair was appended while the employee was mid-turn, giving own user → delegated user → delegated assistant → own assistant.
test('a finished job waits for the employee\'s own turn to end and goes into their conversation whole', async () => {
  const o = await office()
  const { appendBotTurn } = await import('../src/bots.js')
  const kim = (await o.named('김대리'))!, at = '2026-11-16T02:59:00.000Z'
  let busy = true
  await appendBotTurn(o.paths, kim.id, { role: 'user', text: '내 질문', at })
  const wrote = employeeWriteBack(o.paths, { botId: kim.id, brief: '노션 조사', result: '노션 결과' }, new Date('2026-11-16T03:00:00.000Z'), () => busy)
  await new Promise(resolve => setTimeout(resolve, 60))
  // Their memory has the line at once; their conversation is untouched while the turn runs.
  expect((await loadBotMemory(o.paths, kim.id)).facts).toHaveLength(1)
  expect((await readBotTranscript(o.paths, kim.id)).map(turn => turn.text)).toEqual(['내 질문'])
  await appendBotTurn(o.paths, kim.id, { role: 'assistant', text: '내 답', at })
  busy = false
  await wrote
  // A turn that starts the moment the pair is written lands after both halves.
  await appendBotTurn(o.paths, kim.id, { role: 'user', text: '다음 질문', at })
  expect((await readBotTranscript(o.paths, kim.id)).map(turn => [turn.role, turn.text])).toEqual([['user', '내 질문'], ['assistant', '내 답'], ['user', '노션 조사'], ['assistant', '노션 결과'], ['user', '다음 질문']])
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

// grokbar B7 (stack1-f4f6844c): C3 took 131 s with no link (an 11 s merge round, then a 90 s check turn because the merge had no address);
// C6's report was a model's rewrite; C1 and C9 spent a model round on two copied phrases or a question the roster answers.
const part = (id: string, role: string, brief: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: '', ...rest })

test('the merged report is one table: a row per employee, their link, a missing part said in its row', () => {
  const report = mergedReport([
    part('m1', '김대리', '노션', { result: '- **Notion Agent** 업그레이드 (11/12)\n- 새 모델 라우터\n\n출처:\nhttps://www.notion.com/releases' }),
    part('m2', '박사원', '슬랙', { result: 'Salesforce 스워밍 도입 | 채널 자동 생성\n(시간 한도에서 멈춤: 여기까지 찾은 내용)', sources: ['https://slack.com/blog/news', 'https://slack.com/intl/ko-kr/whats-new', 'https://search.naver.com/search.naver?query=slack'] }),
    part('m3', '이과장', '리니어', { state: 'failed', result: 'Failed: it ran out of time before it reported anything.' }),
  ], new Map([['m1', '노션'], ['m2', '슬랙'], ['m3', '리니어']]))
  expect(report.split('\n')).toEqual([
    '김대리, 박사원, 이과장 보고예요.', '', '| 맡은 일 (담당) | 내용 | 출처 |', '|---|---|---|',
    '| 노션 (김대리) | Notion Agent 업그레이드 (11/12) · 새 모델 라우터 | [notion.com](https://www.notion.com/releases) |',
    '| 슬랙 (박사원) | Salesforce 스워밍 도입 / 채널 자동 생성 · (시간 한도에서 멈춤: 여기까지 찾은 내용) | [slack.com](https://slack.com/blog/news) · [slack.com](https://slack.com/intl/ko-kr/whats-new) |',
    '| 리니어 (이과장) | 조사하지 못했어요. | - |',
  ])
  // One table and nothing an internal note or a tool would say.
  expect(report.match(/^\|---/gm)).toHaveLength(1)
  expect(report).not.toMatch(/Failed|ran out of time/)
})

test('one employee\'s report stands as they wrote it, and a handoff keeps the facts it was made from', () => {
  expect(mergedReport([part('m1', '김대리', '행사', { result: '12월 2일 소프트웨이브\nhttps://example.com/a' })])).toBe('김대리 보고예요.\n\n12월 2일 소프트웨이브\nhttps://example.com/a')
  // Nothing written out as an address: the page they read is added as a link.
  expect(mergedReport([part('m1', '김대리', '행사', { result: '12월 2일 소프트웨이브', sources: ['https://example.com/a'] })])).toBe('김대리 보고예요.\n\n12월 2일 소프트웨이브\n\n출처: [example.com](https://example.com/a)')
  // C6 as it ran: 김대리 worked first, his result went on to 박사원 (TeamMember.then), and the task holds both.
  const kim = part('m1', '김대리', '다음 달 서울 IT 행사 일정 정리', { background: true, then: { botId: 'bot-m2', who: '박사원', brief: '홍보 문구 3개' }, result: '소프트웨이브 2026: 12월 2일~4일, 코엑스 https://example.com/sw' })
  const park = part('m2', '박사원', handoffBrief('홍보 문구 3개', '김대리', kim.result!, kim.brief), { background: true, result: '1. 12월, 코엑스에서 만나요\n2. 참가비 무료\n3. 지금 사전등록' })
  const task = { id: 't', goal: 'g', botId: 'chief', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members: [kim, park], hires: 2, maxHires: 8, maxDepth: 3, big: false } } as DelegatedTask
  expect(employeesReport(task)).toBe([
    '박사원 보고예요. 김대리한테 받은 내용으로 했어요.', '', '1. 12월, 코엑스에서 만나요', '2. 참가비 무료', '3. 지금 사전등록', '',
    '김대리한테 받은 내용 (다음 달 서울 IT 행사 일정 정리):', '소프트웨이브 2026: 12월 2일~4일, 코엑스 https://example.com/sw',
  ].join('\n'))
  // The first one failed, so nothing was handed on: his own part says so.
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'failed', result: 'Failed: it was stopped.' }] } })).toBe('김대리 보고예요.\n\n김대리: 조사하지 못했어요.')
  // Someone who needs the person, or a file handed in, is the chief of staff's to report.
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'waiting' }] } })).toBeUndefined()
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, files: ['a.xlsx'] }] } })).toBeUndefined()
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, background: undefined }] } })).toBeUndefined()
  expect(employeesReport(undefined)).toBeUndefined()
})

test('a plain hire of one named employee with one duty is the staff call itself', async () => {
  expect(plainHire('김대리 하나 뽑아줘. 리서치 담당이야')).toEqual({ hire: [{ name: '김대리', title: '리서치 담당' }] })
  expect(plainHire('박사원 뽑아줘, 카피 담당')).toEqual({ hire: [{ name: '박사원', title: '카피 담당' }] })
  expect(plainHire('경쟁사 분석 담당으로 이과장 새로 뽑아주세요')).toEqual({ hire: [{ name: '이과장', title: '경쟁사 분석 담당' }] })
  for (const ask of ['마케팅팀 만들고 김대리랑 새로 박사원 뽑아서 넣어줘. 박사원은 카피 담당', '김대리랑 박사원 뽑아줘. 리서치 담당이야', '김대리 하나 뽑아줘', '김대리 뽑아줘. 리서치 담당이고 꼼꼼하게 출처를 적어', '사람 사진 3장 뽑아줘. 디자인 담당이야', '김대리 내보내줘. 리서치 담당이야', `김대리 뽑아줘. ${'가'.repeat(200)} 담당이야`])
    expect(plainHire(ask), ask).toBeUndefined()
  // The arguments are the ones the staff tool takes: the same reply, the same roster.
  const c = await company()
  expect(await c.run(plainHire('김대리 하나 뽑아줘. 리서치 담당이야')!)).toBe('김대리를 리서치 담당으로 뽑았어요.')
  expect((await c.named('김대리'))!.label).toBe('리서치 담당')
})

test('who one employee is and what they did is answered from the roster and stored work', async () => {
  const o = await office()
  await o.assign({ wait: true, to: [{ who: '김대리', brief: '다음 달 서울 IT 행사 일정 정리' }] })
  await o.assign({ wait: true, to: [{ who: '김대리', brief: '노션 이번 주 신기능 조사' }] })
  const bots = await (await import('../src/bots.js')).loadBots(o.paths), kim = (await o.named('김대리'))!
  o.task.team!.members[0]!.finishedAt = '2026-11-16T01:00:00.000Z'; o.task.team!.members[1]!.finishedAt = '2026-11-16T02:00:00.000Z'
  expect(aboutEmployee('김대리 무슨 일 하는 사람이야?', bots, [o.task], new Map([[kim.id, '마케팅팀']]))).toBe('김대리는 마케팅팀 리서치 담당이에요. 자료를 찾아 출처와 함께 정리한다\n지금은 쉬고 있어요. 최근에 한 일:\n- 노션 이번 주 신기능 조사\n- 다음 달 서울 IT 행사 일정 정리')
  expect(aboutEmployee('박사원은 누구야?', bots, [o.task])).toBe('박사원은 카피 담당이에요.\n아직 맡은 일은 없어요.')
  // Anything more than that one question, two people, or nobody on staff: the model's turn.
  for (const ask of ['김대리랑 박사원 뭐 해?', '김대리 무슨 일 하는 사람인지 표로 정리해줘', '최부장 누구야?', '김대리한테 행사 조사 시켜', '다들 뭐하고 있어?'])
    expect(aboutEmployee(ask, bots, [o.task]), ask).toBeUndefined()
})
