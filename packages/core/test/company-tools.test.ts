import { expect, test, vi } from 'vitest'
import { loadBotMemory, recordFacts } from '../src/bot-memory.js'
import { appendBotTurn, createBot, loadArchivedBots, loadBots, readBotTranscript } from '../src/bots.js'
import { answersItself, checkedReport, writesFromHandover, employeesAnswer, isPartsAsk, jobTitle, reportPrompt, teamName, writtenReport, companyNote, companyStatus, companyStatusTool, isAssignAsk, isCompanyAsk, isDutyAsk, isOutsideAsk, plainHandoff, isStatusAsk, isTeamWorkAsk, staffTool, takesCompanyLane, teamRecord, TEAM_MEMORY } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { changeSidebarLayout, readSidebarLayout } from '../src/sidebar-layout.js'
import { MEMBER_BLOCKED } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

async function company() {
  const paths = await initVault(await tmpVaultRoot('company-tools'), { git: false })
  const chief = await createBot(paths, { name: '엔그램' })
  const changed = vi.fn()
  const tool = staffTool(paths, changed)
  const run = (args: Record<string, unknown>) => tool.run(args, { task: '' })
  const named = async (name: string) => (await loadBots(paths)).find(bot => bot.name === name)
  return { paths, chief, changed, tool, run, named }
}

test('adding makes an agent with a role and a way of working, and says so in one Korean line', async () => {
  const { run, named, changed, tool } = await company()
  expect(await run({ add: [{ name: '지민', role: '리서치 담당', how: '자료를 찾아 출처와 함께 정리한다' }] })).toBe('지민을 리서치 담당으로 추가했어요.')
  const kim = (await named('지민'))!
  expect(kim).toMatchObject({ label: '리서치 담당', purpose: '자료를 찾아 출처와 함께 정리한다' })
  expect(kim.primary).toBeUndefined()
  expect(changed).toHaveBeenCalledTimes(1)
  // Its reply is the answer, and a hidden team member can never change the team.
  expect(tool.closes).toBe(true)
  expect(MEMBER_BLOCKED.test('agents')).toBe(true)
  expect(MEMBER_BLOCKED.test('agents_now')).toBe(true)
  // One flat team: the tool has no word for a company, a rank or a group, and takes none.
  expect(Object.keys((tool.argsSchema as { properties: object }).properties)).toEqual(['add', 'rename', 'remove', 'restore'])
  expect(tool.description).not.toMatch(/CEO|chief|staff|employee|company|title|promot|department|hire|fire/i)
})

test('the team is flat: a second agent is added beside the first, into no group, and a group that was made before stays as it is', async () => {
  const { paths, run, named } = await company()
  await run({ add: [{ name: '지민', role: '리서치 담당' }] })
  // A folder made while there were teams (the person's own sidebar): it is theirs and is left alone.
  const ids = async () => ({ chat: (await loadBots(paths)).map(bot => bot.id) })
  const folder = (await changeSidebarLayout(paths, { kind: 'chat', change: { action: 'create-folder', name: '마케팅팀' } }, await ids())).chat.folders.at(-1)!
  await changeSidebarLayout(paths, { kind: 'chat', change: { action: 'move-item', id: (await named('지민'))!.id, folder: folder.id } }, await ids())
  expect(await run({ add: [{ name: '서연', role: '카피 담당' }] })).toBe('서연을 카피 담당으로 추가했어요.')
  expect((await named('서연'))!.label).toBe('카피 담당')
  const layout = await readSidebarLayout(paths, await ids())
  expect(layout.chat.folders.map(one => one.name)).toEqual(['마케팅팀'])
  expect(layout.chat.items.filter(item => item.folder === folder.id).map(item => item.id)).toEqual([(await named('지민'))!.id])
  // Both are on the one team whatever folder they sit in.
  expect(companyStatus(await loadBots(paths), [])).toBe('지민이랑 서연 모두 지금은 쉬고 있어요.')
})

test('removing archives (memory and transcript kept, restorable) and a rename keeps id, memory and role', async () => {
  const { paths, run, named } = await company()
  await run({ add: [{ name: '지민', role: '리서치 담당', how: '조사한다' }, { name: '서연', role: '카피 담당' }] })
  const kim = (await named('지민'))!, park = (await named('서연'))!
  await recordFacts(paths, kim.id, ['2026-11-16: 노션 신기능 조사를 마쳤다'])
  await recordFacts(paths, park.id, ['2026-11-16: 홍보 문구 3개를 썼다'])
  await appendBotTurn(paths, park.id, { role: 'assistant', text: '문구 3개입니다', at: new Date().toISOString() })

  expect(await run({ remove: ['서연'], rename: [{ who: '지민', name: '지우' }] })).toBe('서연은 뺐고, 지민은 이제 지우예요.')
  expect(await named('서연')).toBeUndefined()
  expect(await named('지민')).toBeUndefined()
  expect(await named('지우')).toMatchObject({ id: kim.id, label: '리서치 담당', purpose: '조사한다' })
  expect((await loadBotMemory(paths, kim.id)).facts.map(fact => fact.text).join()).toContain('노션')
  expect((await loadArchivedBots(paths)).map(bot => bot.id)).toEqual([park.id])
  expect((await loadBotMemory(paths, park.id)).facts).toHaveLength(1)
  expect(await readBotTranscript(paths, park.id)).toHaveLength(1)

  // grokbar H5: adding someone under a removed name brings the same agent back with the role just given (it was refused with the way back).
  expect(await run({ add: [{ name: '서연', role: '글 담당' }] })).toBe('서연은 글 담당으로 다시 불렀어요.')
  expect(await named('서연')).toMatchObject({ id: park.id, label: '글 담당', purpose: '글 담당' })
  // c3b r1: the old role ("카피 담당") stayed as how they work, and the work they were handed was done under it.
  expect(await employeeNote(paths, park.id)).toContain('Your role: 글 담당')
  expect(await employeeNote(paths, park.id)).not.toContain('카피')
  expect((await loadBotMemory(paths, park.id)).facts).toHaveLength(1)
  // Asked back in so many words, they return as they were.
  await run({ remove: ['서연'] })
  expect(await run({ restore: ['서연'] })).toBe('서연이 돌아왔어요.')
  expect(await named('서연')).toMatchObject({ id: park.id, label: '글 담당' })
  // 지민 is a name nobody holds since the rename: adding 지민 makes a new person and 지우 stays 지우.
  expect(await run({ add: [{ name: '지민', role: '조사 담당' }] })).toBe('지민을 조사 담당으로 추가했어요.')
  expect((await named('지민'))!.id).not.toBe(kim.id)
  expect(await named('지우')).toMatchObject({ id: kim.id })
  expect(await loadArchivedBots(paths)).toEqual([])
  // A new role alone, or a new way of working alone.
  expect(await run({ rename: [{ who: '지우', role: '뉴스 담당' }] })).toBe('지우는 이제 뉴스 담당이에요.')
  expect(await run({ rename: [{ who: '지우', how: '매일 아침 뉴스를 찾는다' }] })).toBe('지우의 일하는 방식을 바꿨어요.')
  expect(await named('지우')).toMatchObject({ id: kim.id, label: '뉴스 담당', purpose: '매일 아침 뉴스를 찾는다' })
})

test('a taken name, an unknown name and removing the primary bot are refused in Korean and change nothing', async () => {
  const { paths, run, changed } = await company()
  await run({ add: [{ name: '지민', role: '리서치 담당' }] })
  const before = JSON.stringify(await loadBots(paths))
  expect(await run({ add: [{ name: '지민', role: '영업 담당' }, { name: '하린', role: '디자인 담당' }] })).toBe('지민이라는 이름은 이미 쓰고 있어요. 다른 이름을 알려 주세요.')
  expect(await run({ remove: ['엔그램'] })).toBe('엔그램은 뺄 수 없어요.')
  expect(await run({ remove: ['서연'], rename: [{ who: '지민', name: '엔그램' }] })).toBe('서연이라는 팀원은 없어요.\n엔그램이라는 이름은 이미 쓰고 있어요. 다른 이름을 알려 주세요.')
  expect(await run({ restore: ['없는사람'] })).toBe('뺀 팀원 중에 없는사람은 없어요.')
  expect(JSON.stringify(await loadBots(paths))).toBe(before)
  // The tool makes no group of any kind: what was a team call before does nothing at all.
  await expect(run({ team: [{ name: '마케팅팀', members: ['지민'] }] })).rejects.toThrow('nothing to do')
  expect((await readSidebarLayout(paths, { chat: (await loadBots(paths)).map(bot => bot.id) })).chat.folders).toEqual([])
  expect(changed).toHaveBeenCalledTimes(1)
  await expect(run({})).rejects.toThrow('nothing to do')
  await expect(run({ add: [{ name: '하린' }] })).rejects.toThrow('a role')
})

const task = (over: Partial<DelegatedTask>): DelegatedTask => ({ id: 't', goal: '', botId: '', state: 'done', turns: 1, createdAt: '2026-11-16T01:00:00.000Z', updatedAt: '2026-11-16T01:00:00.000Z', approvals: [], log: [], ...over })
const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: 'r', brief: '', state: 'working', sessionKey: 'k', hiredAt: '2026-11-16T01:00:00.000Z', ...over })

test('status is one Korean line per agent from stored tasks: working, waiting, or idle with the last job', async () => {
  const { paths, run, chief } = await company()
  expect(companyStatus(await loadBots(paths), [])).toContain('아직 팀원이 없어요')
  await run({ add: [{ name: '지민', role: '리서치 담당' }, { name: '서연', role: '카피 담당' }, { name: '도윤', role: '영업 담당' }, { name: '하린', role: '디자인 담당' }] })
  await createBot(paths, { name: '그냥 대화' })
  const bots = await loadBots(paths), id = (name: string) => bots.find(bot => bot.name === name)!.id
  const tasks = [
    task({ id: 'a', botId: id('지민'), state: 'running', goal: '다음 달 서울 IT 행사 일정 정리' }),
    task({ id: 'b', botId: id('서연'), state: 'done', goal: '옛 일', updatedAt: '2026-11-15T01:00:00.000Z' }),
    task({ id: 'c', botId: id('서연'), state: 'done', goal: '홍보 문구 3개' }),
    // Working as a member of the lead's task.
    task({ id: 'd', botId: chief.id, state: 'running', goal: '경쟁사 조사', team: { members: [member({ botId: id('도윤'), brief: '리니어 신기능 조사' })], hires: 1, maxHires: 8, maxDepth: 3, big: false } }),
    task({ id: 'e', botId: id('하린'), state: 'waiting', goal: '로고 시안' }),
  ]
  // grokbar C4: sentences, the job as what it was, and never the live tool step ("search_web: …").
  // c5 C4: one sentence, the ones at work first with what they are on, then who waits, then who is idle.
  expect(companyStatus(bots, tasks)).toBe('지민은 다음 달 서울 IT 행사 일정 정리하고 있고, 도윤은 리니어 신기능 조사하고 있고, 하린은 로고 시안 건으로 답을 기다리고 있고, 서연은 쉬고 있어요.')
  const tool = companyStatusTool(paths)
  expect(tool.closes).toBe(true)
  expect(await tool.run({}, { task: '' })).toMatch(/^지민, .*모두 지금은 쉬고 있어요\.$/)
})

test('only a bare status question skips the model; sentences about the team take the team lane', () => {
  for (const ask of ['다들 뭐 하고 있어?', '다들 뭐하고 있어?', '다들 뭐해', '에이전트들 지금 뭐 하고 있어요?', '팀원들 지금 뭐 하고 있어요?', '지금 누가 뭐 해?', '현황', '팀 현황', 'status', "What's everyone doing?"]) expect(isStatusAsk(ask), ask).toBe(true)
  for (const ask of ['다들 뭐하고 있는지 표로 정리해서 메일로 보내줘', '지민 뭐해?', '현황 보고서 써줘', '뭐해?']) expect(isStatusAsk(ask), ask).toBe(false)
  expect(isCompanyAsk('지민 하나 추가해줘. 리서치 담당이야', [], true)).toBe(true)
  expect(isCompanyAsk('서연은 빼고 지민은 이름을 지우로 바꿔', ['지민', '서연'], true)).toBe(true)
  expect(isCompanyAsk('지우 무슨 일 하는 사람이야?', ['지우'], false)).toBe(true)
  // Changing the team is done on the person's own thread alone, and an ordinary or long message stays on the full lead.
  expect(isCompanyAsk('에이전트 하나 추가해줘', [], false)).toBe(false)
  expect(isCompanyAsk('오늘 날씨 어때?', ['지우'], true)).toBe(false)
  expect(isCompanyAsk(`지우 ${'가'.repeat(200)}`, ['지우'], true)).toBe(false)
  const known = ['지민', '서연', '지우']
  for (const ask of ['서연 다시 불러와', '지민 빼줘', '지민 뭐해?', '지민 지금 뭐 하고 있어?', '지우 담당이 뭐야?', '팀에 누구 있어?', '팀원 누구 있어?', '에이전트 누구 있어?', '에이전트 하나 추가해줘', '지민 이름을 지호로 바꿔줘'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(true)
  // Work that only names an agent needs the full tool set: it never takes the lane.
  for (const ask of ['지민이 만든 엑셀 고쳐줘', '팀 자료 PPT로 만들어줘', '이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', '매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘', '이번 주 팀이 한 일 요약해', '홍보 문구 3개 뽑아줘', '지민 로고 시안 뽑아줘', '과장된 표현만 뽑아줘', '표에 항목 3개 추가해줘', '지민이 쓴 글 좀 봐줘', '팀원 교육 자료 만들어줘', '지민 뭐해? 그리고 어제 그 파일도 열어줘'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(false)
  // No company layer is left to ask for: a department, a rank or a promotion is no sentence of the lane's (the normal path answers it).
  for (const ask of ['디자인팀 하나 만들어줘', '지민 마케팅팀으로 옮겨줘', '지민 승진시켜', '지민 직급이 뭐야?'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(false)
})

// B2 r3: "사람 사진 3장 뽑아줘" took the lane ("사람" read as a person to hire, "뽑아" as hiring) and lost the image tools.
test('picking or making things is never adding an agent: that needs a word for one and no artifact', () => {
  const known = ['지민', '서연', '지우']
  for (const ask of ['사람 사진 3장 뽑아줘', '직원 사진 3장 뽑아줘', '담당자 이름 뽑아줘', '팀원 후보 5개 뽑아줘', '인턴 채용 공고 문구 뽑아줘', '이미지 2개 뽑아줘', '핵심만 세 줄 뽑아줘', '사람 하나 뽑아줘', '대리 운전 번호 뽑아줘', '직원 명단 표 한 장 뽑아줘', '로고 시안 4개 뽑아줘', '3개 뽑아줘', '10장 뽑아줘', '지민 사진 몇 장 뽑아줘', '팀원 소개 문구 추가해줘', '사람 그림 뽑아줘', '슬라이드 2장 추가해줘', '담당자 목록 추가해줘'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(false)
  for (const ask of ['지민 하나 추가해줘. 리서치 담당이야', '에이전트 두 명 추가해줘', '팀원 한 명 뽑아줘. 영업 담당', '디자인 담당 팀원 추가해줘'])
    expect(isCompanyAsk(ask, known, true), ask).toBe(true)
  // Names people gave before the team was flat ("김대리", "박사원") are still names.
  for (const ask of ['김대리 하나 뽑아줘. 리서치 담당이야', '이과장 뽑아줘', '박사원 내보내줘'])
    expect(isCompanyAsk(ask, ['김대리', '박사원'], true), ask).toBe(true)
})

// c1fix r1: C5's "지민한테 맡겼어요" came 5.9 s in, after a model round that only copied the sentence into an assign call.
test('a plain hand-off to one agent on the team is the assign call itself; anything more is left to the model', () => {
  const staff = ['지민', '서연']
  // The same arguments team-runner.test.ts gives assign for "지민한테 맡겼어요.".
  expect(plainHandoff('이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리', staff)).toEqual({ wait: false, to: [{ who: '지민', brief: '다음 달 서울 IT 행사 일정 정리' }] })
  expect(plainHandoff('서연에게 시켜 줘： 경쟁사 가격 조사', staff)?.to).toEqual([{ who: '서연', brief: '경쟁사 가격 조사' }])
  for (const ask of [
    '이거 도윤한테 맡겨: 행사 일정 정리', // not on the team: the model's call adds them
    '지민한테 맡겨', '지민한테 행사 일정 정리 맡겨', // no brief of its own after a colon
    '지민한테 맡겨: 행사 조사하고 끝나면 서연한테 넘겨', '지민이랑 서연한테 맡겨: 행사 조사', // a handoff, two agents
    '지민한테 맡겨: 행사 일정 조사해서 알려줘', '지민한테 맡겨: 행사 일정표 파일로 만들어', // a result in this answer, a file to make
    '지민한테 맡겨: 행사 일정 정리해서 슬랙에 올려', '지민한테 맡겨: 거래처에 메일 보내', // goes outside: never the lane
  ]) expect(plainHandoff(ask, staff), ask).toBeUndefined()
})

// B3 r2: "마케팅팀 이번 주 한 일 요약해서 슬랙에 올려" took the lane, which has no posting tool and so no approval gate to reach.
test('anything that goes outside or names an app keeps the normal path, also on a scheduled run and when it also sets a regular time', () => {
  const who = { staff: ['지민', '서연'], gone: ['도윤'], chief: true }
  for (const ask of ['이번 주 팀이 한 일 요약해서 슬랙에 올려', '팀이 한 일 메일로 보내', '이번 주 팀이 한 일 요약해서 노션에 올려줘', '지민한테 시켜서 거래처에 문자 보내', '지민 뭐하는지 카톡으로 알려줘', '팀이 한 일 요약해서 팀 채널에 공유해']) {
    expect(isOutsideAsk(ask), ask).toBe(true)
    expect(takesCompanyLane(ask, who), ask).toBe(false)
    expect(takesCompanyLane(ask, { ...who, scheduled: true }), `scheduled: ${ask}`).toBe(false)
  }
  // B3 r3: a regular time does not bring an outside post into the lane, which could keep the schedule but never post now. The normal path has both tools.
  for (const ask of ['지금 팀이 한 일 슬랙에 올리고 매주 월요일 9시에도 올려', '매주 월요일 아침 9시에 팀이 한 일 슬랙에 올려', '팀이 한 일 지금 메일로 보내고 매주 금요일 오후 5시에도 보내줘', '매일 아침 9시에 지민 한 일 정리해서 노션에 올리고 오늘 것도 바로 올려', '오늘 실적 팀 채널에 공유하고 매주 월요일 10시마다 공유해', '매달 1일 오전 9시에 거래처에 문자 발송하고 이번 달 건 지금 발송해']) {
    expect(isDutyAsk(ask), ask).toBe(true)
    expect(takesCompanyLane(ask, who), ask).toBe(false)
    expect(takesCompanyLane(ask, { ...who, scheduled: true }), `scheduled: ${ask}`).toBe(false)
  }
  // Nothing outside: the lane still takes them, a scheduled run in the thread included (also one kept in the words used before the team was flat).
  for (const ask of ['이번 주 팀이 한 일 요약해', '지난주 팀이 한 일 요약해줘', '마케팅팀 주간보고 올리기', '이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '지민 뭐해?', '도윤 다시 불러와']) {
    expect(takesCompanyLane(ask, who), ask).toBe(true)
    expect(takesCompanyLane(ask, { ...who, scheduled: true }), `scheduled: ${ask}`).toBe(true)
  }
  expect(takesCompanyLane('이번 주 팀이 한 일 요약해', { ...who, chief: false })).toBe(false)
  // The BAR's own team sentences (C1-C10) keep the lane: an app named as a subject (C3) is not something going outside.
  const all = { staff: ['지민', '서연', '도윤'], chief: true }
  for (const ask of ['지민 하나 추가해줘. 리서치 담당이야', '서연도 추가해줘. 카피 담당이야', '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', '이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', '매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘', '내 일정 뭐 있어?', '서연은 빼고 지민은 이름을 지우로 바꿔', '도윤 무슨 일 하는 사람이야?', '이번 주 팀이 한 일 요약해', '슬랙에서 뭐 나왔는지 지민한테 조사 시켜'])
    expect(takesCompanyLane(ask, all), ask).toBe(true)
  // C3 before anyone but 지민 is on the team: one known name is enough, assign adds the rest.
  expect(takesCompanyLane('이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', { staff: ['지민'], chief: true })).toBe(true)
  expect(takesCompanyLane('오늘 날씨 어때?', who)).toBe(false)
})

test('the prompt note lists the team and gives a named agent\'s memory and finished work', async () => {
  const { paths, run } = await company()
  expect(await companyNote(paths, { bots: await loadBots(paths), message: '안녕', chief: false })).toBe('')
  await run({ add: [{ name: '지우', role: '리서치 담당', how: '조사한다' }, { name: '서연', role: '카피 담당' }] })
  const bots = await loadBots(paths), kim = bots.find(bot => bot.name === '지우')!
  await recordFacts(paths, kim.id, ['2026-11-16: 노션 신기능 조사를 마쳤다'])
  const note = await companyNote(paths, { bots, message: '지우 무슨 일 하는 사람이야?', chief: false, tasks: [task({ botId: kim.id, goal: '다음 달 서울 IT 행사 일정 정리' })] })
  expect(note).toContain('- 지우 — 리서치 담당. How they work: 조사한다')
  expect(note).toContain('노션 신기능 조사')
  expect(note).toContain('2026-11-16: 다음 달 서울 IT 행사 일정 정리')
  expect(note).toContain('- 서연 — 카피 담당')
  expect(note).not.toContain('What 서연 remembers')
  expect(note).not.toContain('ONE agents call')
  const own = await companyNote(paths, { bots, message: '서연 뭐하는 사람이야', chief: true })
  expect(own).toContain('ONE agents call')
  expect(own).toContain('one flat team')
  // No hierarchy is described to the model, on either thread.
  for (const text of [note, own]) expect(text).not.toMatch(/CEO|chief of staff|employee|company|staff|promot|department|job title/i)
})

test('a regular time or a question about what the team did takes the lane by its own matcher; work on files does not', () => {
  for (const ask of ['매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘', '매주 월요일 아침 9시에 AI 뉴스 3개 정리해줘', '평일마다 오후 6시에 지민 업무 정리해서 알려줘', '내 일정 뭐 있어?', '일정 뭐 있어', '정기 보고 뭐 있어?'])
    expect(isDutyAsk(ask), ask).toBe(true)
  for (const ask of ['매주 하는 회의가 너무 많아', '오늘 일정 정리해서 엑셀로 만들어줘', '내 일정에 치과 예약 넣어줘', '다음 달 서울 IT 행사 일정 정리', `매주 월요일 9시에 ${'가'.repeat(200)}`])
    expect(isDutyAsk(ask), ask).toBe(false)
  for (const ask of ['이번 주 팀이 한 일 요약해', '지난주 팀이 한 일 요약해줘', '팀 지난주에 뭐 했어?', '다들 이번 주에 뭐 했어?', '마케팅팀 이번 주 한 일 요약해', '마케팅팀 주간보고 올리기'])
    expect(isTeamWorkAsk(ask), ask).toBe(true)
  for (const ask of ['팀 자료 PPT로 만들어줘', '팀이 한 일 엑셀로 만들어줘', '이번 주 한 일 요약해', '다음 주 팀 회의용 PPT 5장 만들어줘. 주제는 3분기 실적', '팀 회의에서 정한 일 요약해줘', '팀 회의록 요약해줘', `팀이 한 일 ${'가'.repeat(200)}`])
    expect(isTeamWorkAsk(ask), ask).toBe(false)
})

test('what the team did comes from the one team record, with the records kept per group before the team was flat read alongside and left on disk', async () => {
  const { paths, run } = await company()
  await run({ add: [{ name: '지민', role: '리서치 담당' }, { name: '서연', role: '카피 담당' }] })
  const bots = await loadBots(paths), kim = bots.find(bot => bot.name === '지민')!
  expect(await companyNote(paths, { bots, message: '이번 주 팀이 한 일 요약해', chief: true })).toContain('The team has no finished work on record yet')
  // Written while there were teams: one file per sidebar folder.
  const old = '슬랙 신기능 조사 → 슬랙이 허들 요약을 냈다 https://example.com/slack (박사원, 2026-11-14)'
  await recordFacts(paths, '_team-folder1', [old], new Date('2026-11-14T03:00:00Z'))
  await employeeWriteBack(paths, { botId: kim.id, brief: '노션 신기능 조사', result: '노션이 AI 회의록을 냈다 https://example.com/notion' }, new Date('2026-11-16T03:00:00Z'))
  const now = '노션 신기능 조사 → 노션이 AI 회의록을 냈다 https://example.com/notion (지민, 2026-11-16)'
  expect((await loadBotMemory(paths, TEAM_MEMORY)).facts.map(fact => fact.text)).toEqual([now])
  expect((await teamRecord(paths)).facts.map(fact => fact.text).sort()).toEqual([now, old].sort())
  const note = await companyNote(paths, { bots, message: '이번 주 팀이 한 일 요약해', chief: true, now: new Date('2026-11-16T04:00:00Z') })
  expect(note).toContain('The team\'s record')
  // c4 C10: the day is given to the model as 월 일, so the answer cannot copy "11-16".
  expect(note).toContain(now.replace('2026-11-16)', '11월 16일)'))
  expect(note).toContain(old.replace('2026-11-14)', '11월 14일)'))
  expect(note.split('The team\'s record')[1]).not.toMatch(/\d{4}-\d\d-\d\d/)
  expect(note).toContain('schedule add')
  // Nothing was moved or deleted: the old file still holds its line.
  expect((await loadBotMemory(paths, '_team-folder1')).facts.map(fact => fact.text)).toEqual([old])
  // Not asked for, not loaded.
  expect(await companyNote(paths, { bots, message: '지민 뭐해?', chief: true })).not.toContain('The team\'s record')
})

// --- assign: handing work to agents on the team ---
import { parseAsk } from '../src/ask.js'
import { aboutEmployee, assignTool, employeeNote, employeeWriteBack, employeesReport, handedFrom, handoffBrief, mergedReport, plainHire, COMPANY_LANE_TOOLS, type AssignHost } from '../src/company-tools.js'
import { settleMember } from '../src/team-hire-tools.js'

async function office(work: (member: TeamMember) => { answer: string; asked?: boolean; error?: string } = member => ({ answer: `${member.role} 결과 https://example.com/${member.id}` })) {
  const c = await company()
  await c.run({ add: [{ name: '지민', role: '리서치 담당', how: '자료를 찾아 출처와 함께 정리한다' }, { name: '서연', role: '카피 담당' }] })
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

test('assign runs each agent as a member of their own, adds an unknown name on the spot and hands back one attributed answer', async () => {
  const o = await office()
  // grokbar B7 (C3): parts that only look things up come back as the one merged answer, written by the host: one table, a row per
  // employee with their part, their name and their link. No model merges it (the call closes the turn).
  const said = await o.assign({ wait: true, to: [{ who: '지민', brief: '노션 신기능', topic: '노션' }, { who: '서연', brief: '슬랙 신기능', topic: '슬랙' }, { who: '도윤', brief: '리니어 신기능', topic: '리니어' }] })
  const lee = (await o.named('도윤'))!
  expect(lee.label).toBe('리니어 담당')
  expect(said).toBe([
    '도윤은 새로 넣었어요. 지민, 서연, 도윤이 정리해 왔어요.', '', '| 맡은 일 (담당) | 내용과 출처 |', '|---|---|',
    '| 노션 (지민) | 지민 결과 · [example.com](https://example.com/m1) |', '| 슬랙 (서연) | 서연 결과 · [example.com](https://example.com/m2) |', '| 리니어 (도윤) | 도윤 결과 · [example.com](https://example.com/m3) |',
  ].join('\n'))
  // Each is the employee (botId), a fast lookup, and already accepted: the lead needs no review round.
  expect(o.task.team!.members.map(m => [m.botId === (m.role === '도윤' ? lee.id : m.botId), m.lookup, m.state, m.review?.ok, m.background])).toEqual([[true, true, 'released', true, undefined], [true, true, 'released', true, undefined], [true, true, 'released', true, undefined]])
  expect(o.task.team!.members[0]!.botId).toBe((await o.named('지민'))!.id)
  expect(typeof o.tool.closes === 'function' && [o.tool.closes({ wait: true, to: [{ who: '지민', brief: 'a' }] }), o.tool.closes({ wait: true, to: [{ who: '지민', brief: 'a', make: true }] }), o.tool.closes({ wait: false })]).toEqual([true, false, true])
  // A part that makes something still comes back as reports for the lead to merge, with the pages each one read.
  const making = await office()
  const out = JSON.parse(await making.assign({ wait: true, to: [{ who: '지민', brief: '노션 신기능 표로 저장', make: true }, { who: '서연', brief: '슬랙 신기능' }] }))
  expect(out.reports.map((r: { who: string; state: string }) => [r.who, r.state])).toEqual([['지민', 'done'], ['서연', 'done']])
  expect(out.reports[1].result).toContain('https://example.com/m2')
  expect(out.note).toContain('ONE table')
  expect(out.note).toContain('markdown link')
  expect(MEMBER_BLOCKED.test('assign')).toBe(true)
  expect(COMPANY_LANE_TOOLS.has('assign')).toBe(true)
  expect(COMPANY_LANE_TOOLS.size).toBeLessThanOrEqual(16)
  // Handing work off takes the lane by its own matcher (isCompanyAsk leaves work sentences alone).
  for (const ask of ['이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜', '이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', '팀에게 맡겨줘', '민지한테 시켜', '김대리한테 맡겨줘'])
    expect(isAssignAsk(ask, ['지민', '서연', '민지']), ask).toBe(true)
  for (const ask of ['이거 나한테 맡겨', '엄마한테 메일 보내라고 시켜줘', '지민한테 온 메일 보여줘', '피자 시켜줘', '지민 것도 피자 시켜줘', '지민이 만든 엑셀 고쳐줘', `지민한테 맡겨 ${'가'.repeat(200)}`])
    expect(isAssignAsk(ask, ['지민', '서연']), ask).toBe(false)
})

test('assign without waiting answers in one Korean line and leaves the work running in the background', async () => {
  const o = await office()
  expect(await o.assign({ wait: false, to: [{ who: '지민', brief: '다음 달 서울 IT 행사 일정 정리' }] })).toBe('지민한테 맡겼어요.')
  expect(o.later).toEqual([['m1']])
  expect(o.task.team!.members[0]).toMatchObject({ background: true, state: 'hired', role: '지민' })
  expect(await o.assign({ wait: false, to: [{ who: '지민', brief: '조사', then: { who: '서연', brief: '홍보 문구 3개' } }] })).toBe('지민한테 맡기고, 끝나면 서연한테 넘길게요.')
  expect(o.task.team!.members[1]!.then).toEqual({ botId: (await o.named('서연'))!.id, who: '서연', brief: '홍보 문구 3개' })
})

test('a failed part is said as failed, and an agent who needs the person is asked up', async () => {
  const failing = await office(member => member.role === '서연' ? { answer: '', error: 'no source' } : { answer: `${member.role} 결과` })
  const out = await failing.assign({ wait: true, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }] })
  // The missing part is said in its own row, never dropped and never the host's own failure note.
  expect(out.split('\n').slice(-2)).toEqual(['| a (지민) | 지민 결과 |', '| b (서연) | 이번엔 못 찾았어요. |'])
  expect(out).not.toMatch(/Failed|no source/)
  expect(failing.task.team!.members.every(m => m.state === 'released' && !!m.review)).toBe(true)
  const asking = await office(() => ({ answer: '어느 달인가요?', asked: true }))
  expect(parseAsk(await asking.assign({ wait: true, to: [{ who: '지민', brief: 'a' }] }))?.question).toBe('지민: 어느 달인가요?')
  expect(asking.task.team!.members[0]).toMatchObject({ state: 'waiting' })
})

test('a handoff with no new brief joins the job the agent is on, or takes their last finished result', async () => {
  const o = await office()
  const hand = { wait: true, to: [{ who: '지민', then: { who: '서연', brief: '홍보 문구 3개' } }] }
  // Nothing finished and nothing running: refused in Korean, nothing started.
  expect(await o.assign(hand)).toBe('지민이 끝낸 일이 아직 없어서 넘길 게 없어요.')
  expect(o.task.team).toBeUndefined()
  o.attachable(true)
  expect(await o.assign(hand)).toBe('지민이 끝내면 서연한테 넘길게요.')
  expect(o.attached).toHaveLength(2)
  expect(o.task.team).toBeUndefined()
  // Finished earlier (in a task on record): 서연 starts now with that result.
  o.attachable(false)
  const { createTask, updateTask } = await import('../src/delegated-tasks.js')
  const earlier = await createTask(o.paths, '행사 조사', o.chief.id)
  const kim = (await o.named('지민'))!
  await updateTask(o.paths, earlier.id, t => { t.state = 'done'; t.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '행사', botId: kim.id, state: 'released', result: '11월 20일 서울 AI 서밋 https://example.com/summit', sessionKey: 's', hiredAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z' }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  // grokbar B7 (C6): the report is 서연's own result, then the facts it was made from, under whose they were and what that job was.
  expect(await o.assign(hand)).toBe('서연이 지민의 행사로 홍보 문구 3개를 만들었어요.\n\n서연 결과\n\n[example.com](https://example.com/m1)\n\n지민이 찾은 내용: 11월 20일 서울 AI 서밋 · [example.com](https://example.com/summit)')
  // grokbar C6: writing from what was handed over is a writer's job (no web), not a lookup.
  expect(o.task.team!.members[0]).toMatchObject({ writer: true, title: '홍보 문구 3개' })
  expect(o.task.team!.members[0]!.lookup).toBeUndefined()
  expect(o.task.team!.members[0]!.brief).toBe(handoffBrief('홍보 문구 3개', '지민', '11월 20일 서울 AI 서밋 https://example.com/summit', '행사'))
  expect(handedFrom(o.task.team!.members[0]!.brief)).toEqual({ brief: '홍보 문구 3개', from: '지민', job: '행사', result: '11월 20일 서울 AI 서밋 https://example.com/summit' })
  expect(handedFrom(handoffBrief('문구', '지민', '결과'))).toEqual({ brief: '문구', from: '지민', job: '', result: '결과' })
  expect(handedFrom('그냥 일')).toBeUndefined()
})

// B3 r2: the last result was taken from every stored task, so a result from another conversation could land in an employee's brief.
test('a handoff with no new brief never takes a result from another thread', async () => {
  const o = await office()
  const { createBot } = await import('../src/bots.js'), { createTask, updateTask } = await import('../src/delegated-tasks.js')
  const kim = (await o.named('지민'))!, other = await createBot(o.paths, { name: '개인 메모' })
  const elsewhere = await createTask(o.paths, '사적인 일', other.id)
  await updateTask(o.paths, elsewhere.id, t => { t.state = 'done'; t.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '사적인 조사', botId: kim.id, state: 'released', result: '다른 대화의 비공개 결과', sessionKey: 's', hiredAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T09:00:00.000Z' }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  const hand = { wait: true, to: [{ who: '지민', then: { who: '서연', brief: '홍보 문구 3개' } }] }
  expect(await o.assign(hand)).toBe('지민이 끝낸 일이 아직 없어서 넘길 게 없어요.')
  expect(o.task.team).toBeUndefined()
  // With an older result in this thread, that one is handed over, not the newer one from elsewhere.
  const here = await createTask(o.paths, '행사 조사', o.chief.id)
  await updateTask(o.paths, here.id, t => { t.state = 'done'; t.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '행사', botId: kim.id, state: 'released', result: '이 대화의 결과', sessionKey: 's', hiredAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z' }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  await o.assign(hand)
  expect(o.task.team!.members[0]!.brief).toBe(handoffBrief('홍보 문구 3개', '지민', '이 대화의 결과', '행사'))
  expect(JSON.stringify(o.task.team)).not.toContain('비공개')
})

// B3 r2: the pair was appended while the employee was mid-turn, giving own user → delegated user → delegated assistant → own assistant.
test('a finished job waits for the agent\'s own turn to end and goes into their conversation whole', async () => {
  const o = await office()
  const { appendBotTurn } = await import('../src/bots.js')
  const kim = (await o.named('지민'))!, at = '2026-11-16T02:59:00.000Z'
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

test('assign refuses a removed agent and the primary bot, and starts nothing', async () => {
  const o = await office()
  await o.run({ remove: ['서연'] })
  expect(await o.assign({ wait: false, to: [{ who: '서연', brief: 'a' }, { who: '엔그램', brief: 'b' }] })).toBe('서연은 전에 뺀 팀원이에요. "서연 다시 불러와"라고 하면 돌아와요.\n엔그램한테는 맡길 수 없어요. 팀원 이름을 알려 주세요.')
  expect(o.task.team).toBeUndefined()
  expect(o.later).toEqual([])
})

test('a finished job is written to the agent\'s own conversation, their memory and the one team record', async () => {
  const o = await office()
  const kim = (await o.named('지민'))!
  await employeeWriteBack(o.paths, { botId: kim.id, brief: '노션 신기능 조사', result: '노션이 AI 회의록을 추가했습니다. https://notion.so/releases' }, new Date('2026-11-16T03:00:00.000Z'))
  expect((await readBotTranscript(o.paths, kim.id)).map(turn => [turn.role, turn.text])).toEqual([['user', '노션 신기능 조사'], ['assistant', '노션이 AI 회의록을 추가했습니다. https://notion.so/releases']])
  const line = '노션 신기능 조사 → 노션이 AI 회의록을 추가했습니다. https://notion.so/releases (지민, 2026-11-16)'
  expect((await loadBotMemory(o.paths, kim.id)).facts.map(fact => fact.text)).toEqual([line])
  expect((await loadBotMemory(o.paths, TEAM_MEMORY)).facts.map(fact => fact.text)).toEqual([line])
  // A long result is cut to one memory line that still ends on who and when.
  await employeeWriteBack(o.paths, { botId: kim.id, brief: '슬랙 조사', result: '가'.repeat(400) }, new Date('2026-11-16T04:00:00.000Z'))
  const long = (await loadBotMemory(o.paths, kim.id)).facts[1]!.text
  expect(long.length).toBeLessThanOrEqual(160)
  expect(long.endsWith('(지민, 2026-11-16)')).toBe(true)
  // The agent works as themselves: role and memory are in their persona, with no company or rank around them.
  const note = await employeeNote(o.paths, kim.id, new Date('2026-11-16T05:00:00.000Z'))
  expect(note).toContain('You are 지민, 리서치 담당')
  expect(note).toContain('one of the agents on the person\'s team')
  expect(note).toContain('자료를 찾아 출처와 함께 정리한다')
  expect(note).toContain('노션 신기능 조사 →')
  expect(note).not.toMatch(/employee|company|chief of staff|boss/i)
  // There is one team: an agent in a sidebar folder, or in none, writes to the same record.
  const ids = { chat: (await loadBots(o.paths)).map(bot => bot.id) }
  const folder = (await changeSidebarLayout(o.paths, { kind: 'chat', change: { action: 'create-folder', name: '마케팅팀' } }, ids)).chat.folders.at(-1)!
  await changeSidebarLayout(o.paths, { kind: 'chat', change: { action: 'move-item', id: kim.id, folder: folder.id } }, ids)
  await employeeWriteBack(o.paths, { botId: kim.id, brief: '리니어 조사', result: '결과' }, new Date('2026-11-16T06:00:00.000Z'))
  expect((await loadBotMemory(o.paths, TEAM_MEMORY)).facts).toHaveLength(3)
  expect((await loadBotMemory(o.paths, `_team-${folder.id}`)).facts).toEqual([])
})

// grokbar B7 (stack1-f4f6844c): C3 took 131 s with no link (an 11 s merge round, then a 90 s check turn because the merge had no address);
// C6's report was a model's rewrite; C1 and C9 spent a model round on two copied phrases or a question the roster answers.
const part = (id: string, role: string, brief: string, rest: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role, brief, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: '', ...rest })

test('the merged report is one table: a row per agent, their link, a missing part said in its row', () => {
  const report = mergedReport([
    part('m1', '지민', '노션', { result: '- **Notion Agent** 업그레이드 (11/12)\n- 새 모델 라우터\n\n출처:\nhttps://www.notion.com/releases' }),
    part('m2', '서연', '슬랙', { result: 'Salesforce 스워밍 도입 | 채널 자동 생성\n(시간 한도에서 멈춤: 여기까지 찾은 내용)', sources: ['https://slack.com/blog/news', 'https://slack.com/intl/ko-kr/whats-new', 'https://search.naver.com/search.naver?query=slack'] }),
    part('m3', '도윤', '리니어', { state: 'failed', result: 'Failed: it ran out of time before it reported anything.' }),
  ], new Map([['m1', '노션'], ['m2', '슬랙'], ['m3', '리니어']]))
  expect(report.split('\n')).toEqual([
    '지민, 서연, 도윤이 정리해 왔어요.', '', '| 맡은 일 (담당) | 내용과 출처 |', '|---|---|',
    '| 노션 (지민) | Notion Agent 업그레이드 (11/12) · 새 모델 라우터 · [notion.com](https://www.notion.com/releases) |',
    // One link per site, and the search page they started from is not a source when a page was read.
    '| 슬랙 (서연) | Salesforce 스워밍 도입 / 채널 자동 생성 · [slack.com](https://slack.com/blog/news) |',
    '| 리니어 (도윤) | 이번엔 못 찾았어요. |',
    // A result cut short is said once, in words, under the table.
  ])
  expect(report).not.toContain('(여기까지')
  // One table and nothing an internal note or a tool would say.
  expect(report.match(/^\|---/gm)).toHaveLength(1)
  expect(report).not.toMatch(/Failed|ran out of time/)
  // Codex cap (b7 r3): the host's limit note for a result cut short was shown in the row as written.
  expect(report).not.toMatch(/한도|멈춤|stopped at/)
})

test('one agent\'s result stands as they wrote it, and a handoff keeps the facts it was made from', () => {
  expect(mergedReport([part('m1', '지민', '행사', { result: '12월 2일 소프트웨이브\nhttps://example.com/a' })])).toBe('지민이 행사 건 정리해 왔어요.\n\n12월 2일 소프트웨이브\n\n[example.com](https://example.com/a)')
  // Nothing written out as an address: the page they read is added as a link.
  expect(mergedReport([part('m1', '지민', '행사', { result: '12월 2일 소프트웨이브', sources: ['https://example.com/a'] })])).toBe('지민이 행사 건 정리해 왔어요.\n\n12월 2일 소프트웨이브\n\n[example.com](https://example.com/a)')
  // C6 as it ran: 지민 worked first, his result went on to 서연 (TeamMember.then), and the task holds both.
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개' }, result: '소프트웨이브 2026: 12월 2일~4일, 코엑스 https://example.com/sw' })
  const park = part('m2', '서연', handoffBrief('홍보 문구 3개', '지민', kim.result!, kim.brief), { background: true, result: '1. 12월, 코엑스에서 만나요\n2. 참가비 무료\n3. 지금 사전등록' })
  const task = { id: 't', goal: 'g', botId: 'chief', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members: [kim, park], hires: 2, maxHires: 8, maxDepth: 3, big: false } } as DelegatedTask
  expect(employeesReport(task)).toBe([
    '서연이 지민의 다음 달 서울 IT 행사 일정 정리로 홍보 문구 3개를 만들었어요.', '', '1. 12월, 코엑스에서 만나요', '2. 참가비 무료', '3. 지금 사전등록', '',
    '지민이 찾은 내용: 소프트웨이브 2026: 12월 2일~4일, 코엑스 · [example.com](https://example.com/sw)',
  ].join('\n'))
  // The first one found nothing at all, so nothing was handed on: one line names both and says what is missing (c4 H5).
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'failed', result: 'Failed: it was stopped.' }] } })).toBe('지민이 다음 달 서울 IT 행사 일정을 아직 못 찾아서, 서연한테는 못 넘겼어요.')
  // Someone who needs the person, or a file handed in, is the lead's to report.
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'waiting' }] } })).toBeUndefined()
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, files: ['a.xlsx'] }] } })).toBeUndefined()
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, background: undefined }] } })).toBeUndefined()
  expect(employeesReport(undefined)).toBeUndefined()
})

test('adding one named agent with one duty is the agents call itself', async () => {
  expect(plainHire('지민 하나 추가해줘. 리서치 담당이야')).toEqual({ add: [{ name: '지민', role: '리서치 담당' }] })
  expect(plainHire('서연도 추가해줘. 카피 담당이야')).toEqual({ add: [{ name: '서연', role: '카피 담당', also: true }] })
  expect(plainHire('도윤 뽑아줘, 디자인 담당')).toEqual({ add: [{ name: '도윤', role: '디자인 담당' }] })
  expect(plainHire('경쟁사 분석 담당으로 하린 새로 팀에 추가해주세요')).toEqual({ add: [{ name: '하린', role: '경쟁사 분석 담당' }] })
  // A name given before the team was flat is a name like any other.
  expect(plainHire('김대리 하나 뽑아줘. 리서치 담당이야')).toEqual({ add: [{ name: '김대리', role: '리서치 담당' }] })
  for (const ask of ['마케팅팀 만들고 지민이랑 새로 서연 뽑아서 넣어줘. 서연은 카피 담당', '지민이랑 서연 추가해줘. 리서치 담당이야', '지민 하나 추가해줘', '지민 추가해줘. 리서치 담당이고 꼼꼼하게 출처를 적어', '사람 사진 3장 뽑아줘. 디자인 담당이야', '지민 빼줘. 리서치 담당이야', '에이전트 하나 추가해줘. 리서치 담당이야', '사진 추가해줘. 편집 담당이야', `지민 추가해줘. ${'가'.repeat(200)} 담당이야`])
    expect(plainHire(ask), ask).toBeUndefined()
  // It takes the lane by itself, so the host reaches it ("카피" alone reads as something to make).
  expect(takesCompanyLane('서연도 추가해줘. 카피 담당이야', { staff: ['지민'], chief: true })).toBe(true)
  expect(takesCompanyLane('서연도 추가해줘. 카피 담당이야', { staff: ['지민'], chief: false })).toBe(false)
  // The arguments are the ones the agents tool takes: the same reply, the same team.
  const c = await company()
  expect(await c.run(plainHire('지민 하나 추가해줘. 리서치 담당이야')!)).toBe('지민을 리서치 담당으로 추가했어요.')
  expect((await c.named('지민'))!.label).toBe('리서치 담당')
})

test('who one agent is and what they did is answered from the team list and stored work', async () => {
  const o = await office()
  await o.assign({ wait: true, to: [{ who: '지민', brief: '다음 달 서울 IT 행사 일정 정리' }] })
  await o.assign({ wait: true, to: [{ who: '지민', brief: '노션 이번 주 신기능 조사' }] })
  const bots = await (await import('../src/bots.js')).loadBots(o.paths)
  o.task.team!.members[0]!.finishedAt = '2026-11-16T01:00:00.000Z'; o.task.team!.members[1]!.finishedAt = '2026-11-16T02:00:00.000Z'
  expect(aboutEmployee('지민 무슨 일 하는 사람이야?', bots, [o.task])).toBe('지민은 리서치 담당이에요. 요즘은 노션 이번 주 신기능 조사랑 다음 달 서울 IT 행사 일정 정리를 했어요.')
  expect(aboutEmployee('서연은 누구야?', bots, [o.task])).toBe('서연은 카피 담당이에요. 아직 맡은 일은 없어요.')
  // Anything more than that one question, two agents, or nobody on the team: the model's turn.
  for (const ask of ['지민이랑 서연 뭐 해?', '지민 무슨 일 하는 사람인지 표로 정리해줘', '하린 누구야?', '지민한테 행사 조사 시켜', '다들 뭐하고 있어?'])
    expect(aboutEmployee(ask, bots, [o.task]), ask).toBeUndefined()
})

// --- grokbar cycle 3 (stack2-d469cddf): C3, C5, C6, C7, C9, C10, H5 ---
import stored from './fixtures/grokbar-stack2-team.json' with { type: 'json' }
const c3 = stored.c3.members as TeamMember[], c5 = stored.c5.members as TeamMember[]

test('the host\'s own table on the results as they were stored: no notes on the looking, no English sentence, one link per site', () => {
  const report = mergedReport(c3)
  expect(report.split('\n').slice(0, 4)).toEqual(['지민, 서연, 도윤이 정리해 왔어요.', '', '| 맡은 일 (담당) | 내용과 출처 |', '|---|---|'])
  const rows = report.split('\n').filter(line => line.startsWith('| ') && line.includes('('))
  // With no topic from the call, the part is named from the brief.
  expect(rows.map(row => row.split(' | ')[0])).toEqual(['| 맡은 일 (담당)', '| 노션의 이번 주 신기능 조사 (지민)', '| 슬랙의 이번 주 신기능 조사 (서연)', '| 리니어의 이번 주 신기능 조사 (도윤)'])
  expect(rows[2]).toBe('| 슬랙의 이번 주 신기능 조사 (서연) | 이번엔 못 찾았어요. |')
  expect(rows[3]).toContain('Coding agent에 BYOK 지원 추가')
  expect(rows[3]).toContain('[linear.app](https://linear.app/changelog/2026-11-12-bring-your-own-key)')
  // U3, U6, U1 as they were measured.
  expect(report).not.toMatch(/턴|실패|\(여기까지|확인 불가|누락|시도|한도|결과예요|보고/)
  expect(report).not.toMatch(/This week|Bring Your Own Key|entries found/)
  // c3b r1: the quoted headline stayed ("Agents, rebuilt to do more for less"); no run of four English words is left, and the finding it led stays.
  expect(report).not.toMatch(/Agents, rebuilt|(?:[A-Za-z][A-Za-z'’-]*[\s,]+){3}[A-Za-z]/)
  expect(rows[1]).toContain('(지민) | 2026-10-19: Notion Agent 대폭 개선')
  for (const row of rows) { const hosts = [...row.matchAll(/\]\(https?:\/\/([^/)]+)/g)].map(hit => hit[1]); expect(new Set(hosts).size, row).toBe(hosts.length) }
  // c4 C5: nothing is said about a result that was cut short.
  expect(report).not.toMatch(/여기까지|더 있을 수/)
  // C5, one person: who brought it, what they found, the link once, and no "출처:" label for the thread to show twice.
  const one = mergedReport(c5)
  // c4 C5: the lead says what the result is, in the person's words.
  expect(one.split('\n')[0]).toBe('지민이 다음 달 서울 IT 행사 일정 정리해 왔어요.')
  expect(one).toContain('2026-12-02~04')
  expect(one).not.toMatch(/출처|시간 초과|확인하지 못|\(여기까지|결과예요|습니다\.\n\n\(/)
  expect(one.match(/\]\(https:\/\/search\.naver\.com/g)).toHaveLength(1)
})

test('the writer pass: fixed input, the host checks what comes back, and the host\'s table stands in when it fails', async () => {
  const topics = new Map([['m1', '노션'], ['m2', '슬랙'], ['m3', '리니어']])
  const prompt = reportPrompt(stored.c3.goal, c3, topics)
  // The input: the ask, and per member the name, the part, the stored text and the pages; never the host's own limit note.
  expect(prompt).toContain('"name":"지민","part":"노션"')
  expect(prompt).toContain('https://linear.app/changelog/2026-11-12-bring-your-own-key')
  expect(prompt).toContain('나눠서 시켜')
  // c4 C5: the writer is never told a result was cut short, so it cannot say "더 있을 수 있어요".
  expect(prompt).not.toContain('"cut"')
  expect(prompt).not.toMatch(/한도에서 멈춤/)
  expect(prompt).toContain('"맡은 일 (담당)"')
  expect(reportPrompt(stored.c5.goal, c5)).toContain('정리해 왔어요')
  const good = ['노션은 에이전트를 크게 손봤고, 리니어는 자체 키 연결을 넣었어요.', '', '| 맡은 일 (담당) | 내용과 출처 |', '|---|---|',
    '| 노션 (지민) | Notion Agent가 크게 개선됐어요. [Bing 검색](https://www.bing.com/search?q=Notion%20new%20features%20November%202026) |',
    '| 슬랙 (서연) | 이번엔 못 찾았어요. |',
    '| 리니어 (도윤) | 11/12에 BYOK 지원이 추가됐어요. [Linear 변경 기록](https://linear.app/changelog/2026-11-12-bring-your-own-key) [다른 곳](https://evil.example/x) |'].join('\n')
  const asked: string[] = []
  const out = await writtenReport({ ask: stored.c3.goal, members: c3, topics, write: async text => { asked.push(text); return good } })
  expect(asked).toEqual([prompt])
  // Links it was given are kept as written; an address it was not given is dropped, its words stay.
  expect(out).toContain('[Linear 변경 기록](https://linear.app/changelog/2026-11-12-bring-your-own-key)')
  expect(out).toContain('[Bing 검색](https://www.bing.com/search?q=Notion%20new%20features%20November%202026)')
  expect(out).not.toContain('evil.example')
  expect(out).toContain('다른 곳')
  expect(out).toContain('| 슬랙 (서연) | 이번엔 못 찾았어요. |')
  const fallback = mergedReport(c3, topics)
  // A member with no row, a word the person must not read, an English sentence, no table, a throw, nothing, late: the host's table.
  // c3b r1: a row that found something with no link to its own page, and a quoted English headline.
  for (const bad of [good.replace(/ \[Bing 검색\]\([^)]*\)/, ''), good.replace(/\[Bing 검색\]\([^)]*\)/, '[Linear](https://linear.app/changelog/2026-11-12-bring-your-own-key)'), good.replace('Notion Agent가', '"Agents, rebuilt to do more for less"로 Notion Agent가'),
    '찾아왔어요.\n\n| 맡은 일 (담당) | 내용과 출처 |\n|---|---|\n| 노션 (지민) | 개선됐어요. |\n| 슬랙 (서연) | 못 찾았어요. |\n| 리니어 (도윤) | 기능이 나왔어요. |', good.replace(/\n\| 슬랙.*$/m, ''), good.replace('크게 개선됐어요', '조사에 실패했어요'), good.replace('크게 개선됐어요.', 'This week the agent was rebuilt.'), '지민, 서연, 도윤이 다 찾아 왔어요.', ''])
    expect(await writtenReport({ ask: stored.c3.goal, members: c3, topics, write: async () => bad }), bad.slice(0, 40)).toBe(fallback)
  expect(await writtenReport({ ask: stored.c3.goal, members: c3, topics, write: async () => { throw new Error('no model') } })).toBe(fallback)
  expect(await writtenReport({ ask: stored.c3.goal, members: c3, topics, timeoutMs: 20, write: () => new Promise(resolve => setTimeout(() => resolve(good), 200)) })).toBe(fallback)
  expect(await writtenReport({ ask: stored.c3.goal, members: c3, topics })).toBe(fallback)
  // What the call said first stays in front of the writer's text.
  expect(await writtenReport({ ask: stored.c3.goal, members: c3, topics, hired: ['도윤은 새로 넣었어요.'], write: async () => good })).toMatch(/^도윤은 새로 넣었어요\. 노션은/)
  // Nobody found anything: the model is not asked.
  const none = vi.fn(async () => good)
  expect(await writtenReport({ ask: 'x', members: [c3[1]!], write: none })).toBe('슬랙의 이번 주 신기능 조사(서연): 이번엔 못 찾았어요.')
  expect(none).not.toHaveBeenCalled()
  // Three columns would be drawn as a stack of cards in the thread, not as a table.
  expect(checkedReport(good.replace('| 내용과 출처 |', '| 내용 | 출처 |').replace('|---|---|', '|---|---|---|'), c3)).toBeUndefined()
  expect(checkedReport(good, c3)).toBeDefined()
  expect(checkedReport('지민이 정리해 왔어요.\n\n- 12월 2~4일 연말 행사', c5)).toBeUndefined()
  expect(checkedReport('지민이 정리해 왔어요.\n\n- 12월 2~4일 연말 행사\n\n[네이버 검색](https://search.naver.com/search.naver?query=%EC%84%9C%EC%9A%B8%20IT%20%ED%96%89%EC%82%AC%202026%EB%85%84%2012%EC%9B%94%20%EC%9D%BC%EC%A0%95)', c5)).toContain('[네이버 검색](https://search.naver.com/')
})

test('a hand-off result is written in the hand-off shape, and the background report goes through the same writer', async () => {
  const kim = part('m1', '지민', '노션 신기능 조사', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개 뽑기' }, result: 'Notion Agent가 크게 개선됐어요. https://www.notion.com/releases/2026-10-19' })
  const park = part('m2', '서연', handoffBrief('홍보 문구 3개 뽑기', '지민', kim.result!, kim.brief), { background: true, lookup: undefined, writer: true, result: '1. 일은 에이전트에게\n2. 하루를 맡기세요\n3. 더 적은 비용으로' })
  const task = { id: 't', goal: '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', botId: 'chief', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members: [kim, park], hires: 2, maxHires: 8, maxDepth: 3, big: false } } as DelegatedTask
  const prompt = reportPrompt(task.goal, task.team!.members)
  expect(prompt).toContain('exactly as they wrote them')
  expect(prompt).toContain('"from":{"name":"지민","job":"노션 신기능 조사"')
  expect(prompt).toContain('https://www.notion.com/releases/2026-10-19')
  const written = '서연이 지민의 노션 신기능 조사로 홍보 문구 3개 뽑았어요.\n\n1. 일은 에이전트에게\n2. 하루를 맡기세요\n3. 더 적은 비용으로\n\n지민이 찾은 내용: Notion Agent가 크게 개선됐어요. [Notion 릴리스 노트](https://www.notion.com/releases/2026-10-19)'
  expect(await employeesAnswer(task, async () => written)).toBe(written)
  // No model, or a text that fails the check: the host's own lines, with both names, the three lines and the link.
  const own = await employeesAnswer(task)
  expect(own).toBe(employeesReport(task))
  expect(own).toBe('서연이 지민의 노션 신기능 조사로 홍보 문구 3개 뽑았어요.\n\n1. 일은 에이전트에게\n2. 하루를 맡기세요\n3. 더 적은 비용으로\n\n지민이 찾은 내용: Notion Agent가 크게 개선됐어요. · [notion.com](https://www.notion.com/releases/2026-10-19)')
  expect(await employeesAnswer(task, async () => '서연 결과예요.')).toBe(own)
  expect(await employeesAnswer({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'waiting' }] } }, async () => written)).toBeUndefined()
})

// grokbar c3b r2: 지민 read a page but his memo named no address; the hand-off dropped it and the answer went out uncited.
test('a hand-off carries the pages the first teammate read when the memo names none', async () => {
  const kim = part('m1', '지민', '서울 날씨 조사', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '나들이 문구 쓰기' }, result: '토요일 서울은 맑고 20도예요.', sources: ['https://weather.example/seoul'] })
  const uncited = '서연이 지민의 서울 날씨 조사로 나들이 문구 썼어요.\n\n맑은 토요일, 가볍게 나들이 가요.\n\n지민이 찾은 내용: 토요일 서울은 맑고 20도예요.'
  const cited = `${uncited} [날씨 예보](https://weather.example/seoul)`
  const own = '서연이 지민의 서울 날씨 조사로 나들이 문구 썼어요.\n\n맑은 토요일, 가볍게 나들이 가요.\n\n지민이 찾은 내용: 토요일 서울은 맑고 20도예요. · [weather.example](https://weather.example/seoul)'
  // The brief carries them (the one handing over may be in another task: assign's "last finished job"); a memo with its own address is left as it is.
  const carried = handoffBrief('나들이 문구 쓰기', '지민', kim.result!, kim.brief, kim.sources)
  expect(carried.endsWith('토요일 서울은 맑고 20도예요.\nhttps://weather.example/seoul')).toBe(true)
  expect(handoffBrief('문구', '지민', '맑아요 https://a.example/x', '', ['https://b.example/y'])).not.toContain('b.example')
  // And a brief written without them still finds the pages on the one who handed over.
  for (const brief of [carried, handoffBrief('나들이 문구 쓰기', '지민', kim.result!, kim.brief)]) {
    const members = [kim, part('m2', '서연', brief, { background: true, lookup: undefined, writer: true, result: '맑은 토요일, 가볍게 나들이 가요.' })]
    expect(mergedReport(members)).toBe(own)
    expect(reportPrompt('날씨 보고 문구 써줘', members)).toContain('"pages":["https://weather.example/seoul"]')
    expect(checkedReport(uncited, members)).toBeUndefined()
    expect(checkedReport(cited, members)).toBe(cited)
    expect(await writtenReport({ ask: '날씨 보고 문구 써줘', members, write: async () => uncited })).toBe(own)
  }
})

// c3b review r3 (Codex): a memo that named only a search-results address counted as cited, so the page the teammate read was dropped
// from the hand-off, the host's answer and the writer's prompt, and an answer citing only the search was let through.
test('a hand-off whose memo names only a search-results address still carries the page that was read', async () => {
  const search = 'https://search.naver.com/search.naver?query=seoul', page = 'https://weather.example/seoul'
  const kim = part('m1', '지민', '서울 날씨 조사', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '문구 쓰기' }, result: `서울은 맑아요. ${search}`, sources: [page] })
  const carried = handoffBrief('문구 쓰기', '지민', kim.result!, kim.brief, kim.sources)
  expect(carried.endsWith(`\n${page}`)).toBe(true)
  // A brief written before this fix (no page in it) is cited from the handing teammate's record too.
  for (const brief of [carried, handoffBrief('문구 쓰기', '지민', kim.result!, kim.brief)]) {
    const members = [kim, part('m2', '서연', brief, { background: true, lookup: undefined, writer: true, result: '맑은 서울로 떠나요.' })]
    expect(mergedReport(members)).toContain(`[weather.example](${page})`)
    expect(mergedReport(members)).not.toContain('search.naver.com')
    expect(reportPrompt('문구 써줘', members)).toContain(page)
    const text = '서연이 지민의 서울 날씨 조사로 문구 썼어요.\n\n맑은 서울로 떠나요.\n\n지민이 찾은 내용: 서울은 맑아요.'
    expect(checkedReport(`${text} [네이버 검색](${search})`, members)).toBeUndefined()
    expect(checkedReport(`${text} [날씨 예보](${page})`, members)).toBe(`${text} [날씨 예보](${page})`)
  }
  // Nothing read but the search: the search address still stands in, as before.
  expect(mergedReport([part('m1', '지민', '서울 날씨 조사', { background: true, result: `서울은 맑아요. ${search}` })])).toContain('search.naver.com')
})

test('a name as people write it names the teammate: 지민이, 지민이는, 지민이랑, 지민한테, 지민 씨', async () => {
  const staff = ['지민', '서연', '도윤', '지민아']
  for (const word of ['지민', '지민이', '지민이는', '지민이랑', '지민한테', '지민이한테', '지민 씨', '지민씨는', '지민은', '지민님']) expect(teamName(word, staff), word).toBe('지민')
  expect(teamName('지민아', staff)).toBe('지민아')
  for (const word of ['지민이네 집', '지민석', '민지', '']) expect(teamName(word, staff), word).toBeUndefined()
  // assign never adds "지민이" when 지민 is on the team; someone new named with the filler joins under their name.
  const o = await office()
  expect(await o.assign({ wait: false, to: [{ who: '지민이', brief: '날씨 조사', then: { who: '서연이는', brief: '문구 한 줄 써줘' } }, { who: '도윤이', brief: '뉴스 조사' }] })).toBe('도윤은 새로 넣고, 지민, 도윤한테 나눠 맡겼어요. 지민이 끝내면 서연한테 넘길게요.')
  expect((await loadBots(o.paths)).map(bot => bot.name).sort()).toEqual(['도윤', '서연', '엔그램', '지민'])
  expect(o.task.team!.members.map(m => [m.role, m.title, m.then?.who])).toEqual([['지민', '날씨 조사', '서연'], ['도윤', '뉴스 조사', undefined]])
  // "who is" takes the name the same way.
  expect(aboutEmployee('서연이는 무슨 일 하는 사람이야?', await loadBots(o.paths), [])).toBe('서연은 카피 담당이에요. 아직 맡은 일은 없어요.')
})

test('one hand-off sentence, whoever is new and however many take a part', async () => {
  const o = await office()
  expect(await o.assign({ wait: false, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }, { who: '도윤', brief: 'c', topic: '리니어' }] })).toBe('도윤은 새로 넣고, 지민, 서연, 도윤한테 나눠 맡겼어요.')
  expect(await o.assign({ wait: false, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }, { who: '도윤', brief: 'c', topic: '리니어' }] })).toBe('지민, 서연, 도윤한테 나눠 맡겼어요.')
  // The part's name and what the job was ride on the member: the report that comes back later names the row from them.
  expect(o.task.team!.members.at(-1)).toMatchObject({ topic: '리니어', title: 'c' })
  expect(mergedReport([{ ...o.task.team!.members.at(-1)!, state: 'done', result: '새 기능' }, { ...o.task.team!.members[0]!, state: 'done', result: '새 기능' }])).toContain('| 리니어 (도윤) | 새 기능 |')
})

test('what a job was, from the words it was asked in', () => {
  for (const [brief, title] of [
    ['노션의 이번 주 신기능을 조사해서 정리해줘.', '노션의 이번 주 신기능 조사'], ['다음 달 서울 IT 행사 일정 정리', '다음 달 서울 IT 행사 일정 정리'], ['홍보 문구 3개 뽑게 해', '홍보 문구 3개 뽑기'],
    ['이번 주말 서울 날씨 찾아보고', '이번 주말 서울 날씨 찾기'], ['주말 나들이 추천 문구 한 줄 써줘', '주말 나들이 추천 문구 한 줄 쓰기'], ['경쟁사 가격을 조사해 주세요', '경쟁사 가격 조사'], ['회의록 요약해줘', '회의록 요약'], ['가을 축제 피해', '가을 축제 피해'],
    [handoffBrief('홍보 문구 3개 뽑기', '지민', '결과'), '홍보 문구 3개 뽑기'],
    // stack-3 (c3b run C4): the lead's own brief, with glosses in brackets and "…조사해서 핵심 내용 정리해줘", read "…업데이트를 …를 했어요."
    ['노션(Notion)의 이번 주(최근 7일 내) 신기능 발표나 업데이트를 조사해서 핵심 내용 정리해줘.', '노션의 이번 주 신기능 발표나 업데이트 조사'],
    // c4 C4/C9: the other two briefs of that run, same shape; none may come out cut ("…를 했어요.").
    ['슬랙(Slack)의 이번 주(최근 7일 내) 신기능 발표나 업데이트를 조사해서 핵심 내용 정리해줘.', '슬랙의 이번 주 신기능 발표나 업데이트 조사'],
    ['리니어(Linear)의 이번 주(최근 7일 내) 신기능 발표나 업데이트를 조사해서 핵심 내용 정리해줘.', '리니어의 이번 주 신기능 발표나 업데이트 조사'],
  ] as const) expect(jobTitle(brief), brief).toBe(title)
})

test('a hand-off from one teammate to the next, and a part each for two, are the assign call itself', async () => {
  const staff = ['지민', '서연', '도윤']
  expect(plainHandoff('지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', staff)).toEqual({ wait: false, to: [{ who: '지민', then: { who: '서연', brief: '홍보 문구 3개 뽑기' } }] })
  expect(plainHandoff('도윤이 일 다 끝나면 지민이한테 넘겨서 한 줄로 요약해줘', staff)).toEqual({ wait: false, to: [{ who: '도윤', then: { who: '지민', brief: '한 줄로 요약해줘' } }] })
  expect(plainHandoff('지민이는 이번 주말 서울 날씨 찾아보고, 서연이는 그걸로 주말 나들이 추천 문구 한 줄 써줘', staff)).toEqual({ wait: false, to: [{ who: '지민', brief: '이번 주말 서울 날씨 찾기', then: { who: '서연', brief: '주말 나들이 추천 문구 한 줄 써줘' } }] })
  expect(plainHandoff('도윤은 환율 조사하고 지민은 그 결과로 한 문단 써줘', staff)?.to).toEqual([{ who: '도윤', brief: '환율 조사', then: { who: '지민', brief: '한 문단 써줘' } }])
  for (const ask of [
    '하린 조사 끝나면 서연한테 넘겨서 문구 뽑게 해', '지민 조사 끝나면 지민한테 넘겨서 요약해줘', // someone not on the team, the same person twice
    '지민 조사 끝나면 서연한테 넘겨서 엑셀 파일로 만들어줘', '지민 조사 끝나면 서연한테 넘겨서 거래처에 메일 보내', // a file to make, going outside
    '지민이는 날씨 찾아보고, 서연이는 그걸로 문구 써서 슬랙에 올려줘', '지민이는 날씨 찾아보고, 하린이는 그걸로 문구 써줘',
    '지민이는 날씨 찾아보고 서연이는 뉴스 찾아줘', // two separate jobs: the model splits them
  ]) expect(plainHandoff(ask, staff), ask).toBeUndefined()
  // Both branches of the host-made call. 지민 is working: 서연 is attached to that job.
  const o = await office()
  const hand = plainHandoff('지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', ['지민', '서연'])!
  o.attachable(true)
  expect(await o.assign(hand)).toBe('지민이 끝내면 서연한테 넘길게요.')
  expect(o.attached.at(-1)).toMatchObject({ then: { who: '서연', brief: '홍보 문구 3개 뽑기' } })
  // 지민 is idle: 서연 gets what 지민 last finished in this thread, as a writer with no web, in the background.
  o.attachable(false)
  const { createTask, updateTask } = await import('../src/delegated-tasks.js')
  const earlier = await createTask(o.paths, '경쟁사 조사', o.chief.id), kim = (await o.named('지민'))!
  await updateTask(o.paths, earlier.id, t => { t.state = 'done'; t.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '노션 신기능 조사', botId: kim.id, state: 'released', result: 'Notion Agent 개선 https://www.notion.com/releases', sessionKey: 's', hiredAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z' }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  expect(await o.assign(hand)).toBe('지민이 한 걸 서연한테 넘겼어요.')
  expect(o.task.team!.members[0]).toMatchObject({ role: '서연', writer: true, background: true, title: '홍보 문구 3개 뽑기' })
  expect(handedFrom(o.task.team!.members[0]!.brief)).toMatchObject({ from: '지민', job: '노션 신기능 조사', result: 'Notion Agent 개선 https://www.notion.com/releases' })
  // A handed-over job that says to look something up still runs as a lookup.
  expect(['홍보 문구 3개 뽑기', '주말 나들이 추천 문구 한 줄 써줘', '한 줄로 요약해줘', '영어로 번역해줘'].map(writesFromHandover)).toEqual([true, true, true, true])
  expect(['그걸로 경쟁사 가격도 조사해줘', '관련 뉴스 찾아줘'].map(writesFromHandover)).toEqual([false, false])
})

test('a sentence that gives named teammates their parts takes the team lane; one that goes outside does not', () => {
  const who = { staff: ['지민', '서연', '도윤'], chief: true }
  for (const ask of [
    '지민이는 이번 주말 서울 날씨 찾아보고, 서연이는 그걸로 주말 나들이 추천 문구 한 줄 써줘', '서연은 이 문장 영어로 번역해줘', '지민이 날씨 찾아보고 서연이 문구 써줘',
    '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', '지민이랑 서연이 팀에 추가해줘. 지민이는 조사 담당, 서연이는 글 담당', '도윤이는 무슨 일 하는 사람이야?',
  ]) expect(takesCompanyLane(ask, who), ask).toBe(true)
  for (const ask of [
    '지민이는 날씨 찾아보고, 서연이는 그걸로 문구 써서 슬랙에 올려줘', '서연은 이 정리본 민호한테 메일로 보내줘', // outside: the normal path and its approval
    '지민이 만든 엑셀 고쳐줘', '지민은 어제 뭐라고 했더라', '이번 주말 서울 날씨 찾아줘', '민호는 이거 번역해줘', // a job for the one being asked, a question, nobody named, nobody on the team
  ]) expect(takesCompanyLane(ask, who), ask).toBe(false)
  expect(isPartsAsk('서연은 이 문장 영어로 번역해줘', ['서연'])).toBe(true)
  expect(takesCompanyLane('서연은 이 문장 영어로 번역해줘', { ...who, chief: false })).toBe(false)
})

test('two or three people are added in one sentence, a removed name comes back, and it is said in one line', async () => {
  expect(plainHire('지민이랑 서연이 팀에 추가해줘. 지민이는 조사 담당, 서연이는 글 담당')).toEqual({ add: [{ name: '지민', role: '조사 담당' }, { name: '서연', role: '글 담당' }] })
  expect(plainHire('하린, 도윤, 민호 추가해줘. 하린은 디자인 담당, 도윤은 영업 담당이고 민호는 고객 응대 담당이야')).toEqual({ add: [{ name: '하린', role: '디자인 담당' }, { name: '도윤', role: '영업 담당' }, { name: '민호', role: '고객 응대 담당' }] })
  for (const ask of ['지민이랑 서연이 팀에 추가해줘. 지민이는 조사 담당', '지민이랑 서연이 팀에 추가해줘. 지민이는 조사 담당, 하린이는 글 담당', '지민이랑 지민이 추가해줘. 지민이는 조사 담당, 지민이는 글 담당', '사진이랑 로고 추가해줘. 사진은 편집 담당, 로고는 디자인 담당', '가, 나, 다, 라 추가해줘. 가는 a 담당'])
    expect(plainHire(ask), ask).toBeUndefined()
  // C8 then H5 as they ran: 지민 was renamed 지우 and 서연 was removed; then both names are added again.
  const c = await company()
  await c.run({ add: [{ name: '지민', role: '리서치 담당' }, { name: '서연', role: '카피 담당' }] })
  const kim = (await c.named('지민'))!, park = (await c.named('서연'))!
  await c.run({ remove: ['서연'], rename: [{ who: '지민', name: '지우' }] })
  expect(await c.run(plainHire('지민이랑 서연이 팀에 추가해줘. 지민이는 조사 담당, 서연이는 글 담당')!)).toBe('지민은 조사 담당으로 넣고, 서연은 글 담당으로 다시 불렀어요.')
  expect(await c.named('서연')).toMatchObject({ id: park.id, label: '글 담당' })
  expect((await c.named('지민'))!.id).not.toBe(kim.id)
  expect(await c.named('지우')).toMatchObject({ id: kim.id, label: '리서치 담당' })
  const fresh = await company()
  expect(await fresh.run(plainHire('지민이랑 서연이 팀에 추가해줘. 지민이는 조사 담당, 서연이는 글 담당')!)).toBe('지민은 조사 담당, 서연은 글 담당으로 넣었어요.')
})

test('who someone is and what everyone is doing, on the tasks as they were stored', async () => {
  const c = await company()
  await c.run({ add: [{ name: '지우', role: '리서치 담당' }, { name: '서연', role: '카피 담당' }, { name: '도윤', role: '리서치 담당' }] })
  const bots = await loadBots(c.paths), id = (name: string) => bots.find(bot => bot.name === name)!.id
  // The members as stored (the name they had then, 지민), now tied to the bots of this vault.
  const own = (members: TeamMember[], ids: string[]) => members.map((m, i) => ({ ...m, botId: ids[i]! }))
  const tasks = [
    { ...task({ id: 'c3', botId: c.chief.id, state: 'done' as const, goal: stored.c3.goal }), team: { members: own(c3, [id('지우'), id('서연'), id('도윤')]), hires: 3, maxHires: 8, maxDepth: 3, big: false } },
    { ...task({ id: 'c5', botId: c.chief.id, state: 'done' as const, goal: stored.c5.goal }), team: { members: own(c5, [id('지우')]), hires: 1, maxHires: 8, maxDepth: 3, big: false } },
  ]
  expect(aboutEmployee('지우 무슨 일 하는 사람이야?', bots, tasks)).toBe('지우는 리서치 담당이에요. 요즘은 다음 달 서울 IT 행사 일정 정리랑 노션의 이번 주 신기능 조사를 했어요.')
  expect(companyStatus(bots, tasks)).toBe('셋 다 지금은 쉬고 있어요. 마지막으로 지우는 다음 달 서울 IT 행사 일정 정리, 서연은 슬랙의 이번 주 신기능 조사, 도윤은 리니어의 이번 주 신기능 조사를 끝냈어요.')
  expect(`${aboutEmployee('지우 무슨 일 하는 사람이야?', bots, tasks)}${companyStatus(bots, tasks)}`).not.toMatch(/해줘|최근에 한 일:|^- |—/m)
  // stack-3 (c3b run C4): a title stored cut short is never said as a job ("…업데이트를 …를 했어요."): the part's short name stands in.
  const cut = [{ ...tasks[0]!, team: { ...tasks[0]!.team, members: tasks[0]!.team.members.map((m, i) => i === 1 ? { ...m, title: '슬랙(Slack)의 이번 주(최근 7일 내) 신기능 발표나 업데이트를 조…', topic: '슬랙 신기능 조사' } : m) } }, tasks[1]!]
  expect(companyStatus(bots, cut)).toContain('서연은 슬랙 신기능 조사, 도윤은')
  // What the host answers by itself, so the turn shows no first line before it.
  for (const ask of ['다들 뭐 하고 있어?', '내 일정 뭐 있어?', '서연은 빼고 지우는 이름을 지민으로 바꿔', '지우 무슨 일 하는 사람이야?', '하린 하나 추가해줘. 디자인 담당이야', '이거 지우한테 맡겨: 다음 달 서울 IT 행사 일정 정리', '지우 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', '매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘'])
    expect(answersItself(ask, bots), ask).toBe(true)
  for (const ask of ['이번 주 팀이 한 일 요약해', '원달러 환율 지금 얼마야?', '이거 지우한테 맡겨: 정리해서 슬랙에 올려', '매주 월요일 9시에 슬랙에 요약 올려줘'])
    expect(answersItself(ask, bots), ask).toBe(false)
})

test('the team record gets a line for every finished part: a hand-off says whose work it was made from, and nothing found is said plainly', async () => {
  const o = await office()
  const kim = (await o.named('지민'))!, park = (await o.named('서연'))!, at = new Date('2026-11-16T03:00:00.000Z')
  await employeeWriteBack(o.paths, { botId: park.id, brief: handoffBrief('홍보 문구 3개 뽑기', '지민', 'Notion Agent 개선', '노션 신기능 조사'), result: '1. 일은 에이전트에게\n2. 하루를 맡기세요', title: '홍보 문구 3개 뽑기' }, at)
  await employeeWriteBack(o.paths, { botId: park.id, brief: '슬랙의 이번 주 신기능을 조사해서 정리해줘.', result: '' }, at)
  await employeeWriteBack(o.paths, { botId: kim.id, brief: c3[1]!.brief, result: c3[1]!.result! }, at)
  await employeeWriteBack(o.paths, { botId: kim.id, brief: '리니어 조사', result: 'Failed: it ran out of time before it reported anything.' }, at)
  const lines = (await loadBotMemory(o.paths, TEAM_MEMORY)).facts.map(fact => fact.text)
  expect(lines).toEqual([
    '홍보 문구 3개 뽑기 (지민한테 받아서) → 1. 일은 에이전트에게 2. 하루를 맡기세요 (서연, 2026-11-16)',
    '슬랙의 이번 주 신기능 조사 → 못 찾았어요 (서연, 2026-11-16)',
    '슬랙의 이번 주 신기능 조사 → 못 찾았어요 (지민, 2026-11-16)',
    '리니어 조사 → 못 찾았어요 (지민, 2026-11-16)',
  ])
  expect(lines.join('\n')).not.toMatch(/Failed|ran out of time|실패|턴|확인 불가/)
  // Only a job that brought something back goes into the agent's own conversation.
  expect((await readBotTranscript(o.paths, park.id)).map(turn => turn.role)).toEqual(['user', 'assistant'])
  expect(await readBotTranscript(o.paths, kim.id)).toEqual([])
})

test('what the team did: the prompt asks for sentences with who and day, bans failure words, and a renamed teammate has one name', async () => {
  const c = await company()
  await c.run({ add: [{ name: '지민', role: '리서치 담당' }, { name: '서연', role: '카피 담당' }] })
  const kim = (await c.named('지민'))!
  await employeeWriteBack(c.paths, { botId: kim.id, brief: '노션 신기능 조사', result: 'Notion Agent 개선' }, new Date('2026-11-16T03:00:00.000Z'))
  await c.run({ rename: [{ who: '지민', name: '지우' }] })
  const tasks = [{ ...task({ id: 'a', botId: c.chief.id, state: 'done', goal: '조사' }), team: { members: [member({ botId: kim.id, role: '지민', brief: '노션 신기능 조사', state: 'released' })], hires: 1, maxHires: 8, maxDepth: 3, big: false } }]
  const note = await companyNote(c.paths, { bots: await loadBots(c.paths), message: '이번 주 팀이 한 일 요약해', tasks, chief: true, now: new Date('2026-11-17T03:00:00.000Z') })
  expect(note).toContain('노션 신기능 조사 → Notion Agent 개선 (지우, 11월 16일)')
  // (The prompt's own examples say 지민; the record's lines do not.)
  expect(note.split('\n').filter(line => line.startsWith('  ')).join('\n')).not.toContain('지민')
  for (const said of ['two to four sentences', '해요체', 'never a sentence per person', 'never as digits with a dash', 'never write 실패, 확인 실패 or 오류', 'the name in "Team now" only']) expect(note, said).toContain(said)
  // Only where the record says who did it: another person's name that starts the same way is not touched (rule 11's 지민호).
  await employeeWriteBack(c.paths, { botId: kim.id, brief: '지민호 님 미팅 준비', result: '지민호 님과 3시 미팅' }, new Date('2026-11-16T04:00:00.000Z'))
  expect(await companyNote(c.paths, { bots: await loadBots(c.paths), message: '이번 주 팀이 한 일 요약해', tasks, chief: true, now: new Date('2026-11-17T03:00:00.000Z') })).toContain('지민호 님 미팅 준비 → 지민호 님과 3시 미팅 (지우, 11월 16일)')
  // A name someone else holds now is left as written: the old 지민's lines are not given to a new 지민.
  await c.run({ add: [{ name: '지민', role: '조사 담당' }] })
  expect(await companyNote(c.paths, { bots: await loadBots(c.paths), message: '이번 주 팀이 한 일 요약해', tasks, chief: true, now: new Date('2026-11-17T03:00:00.000Z') })).toContain('(지민, 11월 16일)')
})

// --- grokbar cycle 4 (c4b) ---
import { askedCount, dutyList, dutyToCancel, isDutyListAsk, plainChange, plainSplit } from '../src/company-tools.js'
import type { BotTask } from '../src/bots.js'

test('c4 C3: a plain split is the assign call itself: thing i goes to name i, and anything unsure is left to the model', async () => {
  const staff = ['지민', '서연']
  const c3 = '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜'
  expect(plainSplit(c3, staff)).toEqual({ wait: false, to: [
    { who: '지민', brief: '이번 주 노션 신기능 조사해서 알려줘', topic: '노션' },
    { who: '서연', brief: '이번 주 슬랙 신기능 조사해서 알려줘', topic: '슬랙' },
    { who: '도윤', brief: '이번 주 리니어 신기능 조사해서 알려줘', topic: '리니어' },
  ] })
  expect(jobTitle(plainSplit(c3, staff)!.to[0]!.brief)).toBe('이번 주 노션 신기능 조사')
  // Two names, a bare list, names with particles, and the other word order.
  expect(plainSplit('노션, 슬랙 가격 조사해줘. 지민이랑 서연이한테 나눠서 시켜', staff)?.to.map(one => [one.who, one.topic, one.brief])).toEqual([['지민', '노션', '노션 가격 조사해줘'], ['서연', '슬랙', '슬랙 가격 조사해줘']])
  expect(plainSplit('서울, 부산 이번 주말 날씨 찾아줘. 지민, 서연에게 각각 맡겨줘.', staff)?.to.map(one => one.brief)).toEqual(['서울 이번 주말 날씨 찾아줘', '부산 이번 주말 날씨 찾아줘'])
  expect(plainSplit('지민, 서연한테 나눠서 시켜: 노션, 슬랙 신기능 조사해줘', staff)?.to.map(one => one.topic)).toEqual(['노션', '슬랙'])
  // Counts differ, no clear list, a file to make, somewhere outside, one name twice: the model's call.
  for (const ask of ['노션, 슬랙, 리니어 신기능 조사해서 알려줘. 지민, 서연한테 나눠서 시켜', '경쟁사 신기능 조사해서 알려줘. 지민, 서연한테 나눠서 시켜', '노션, 슬랙 비교 파일 만들어줘. 지민, 서연한테 나눠서 시켜', '노션, 슬랙 신기능 조사해서 슬랙에 올려줘. 지민, 서연한테 나눠서 시켜', '노션, 슬랙 신기능 조사해줘. 지민, 지민한테 나눠서 시켜', '아이폰 18, 갤럭시 S27, 픽셀 11 가격 조사해줘. 지민, 서연, 도윤한테 나눠서 시켜', '이거 지민한테 맡겨: 노션, 슬랙 조사'])
    expect(plainSplit(ask, staff), ask).toBeUndefined()
  // The host answers it itself (no first line), and the call's own line is the hand-off: one sentence, 60 characters at most.
  const o = await office()
  expect(answersItself(c3, await loadBots(o.paths))).toBe(true)
  const line = await o.assign(plainSplit(c3, staff)!)
  expect(line).toBe('도윤은 새로 넣고, 지민, 서연, 도윤한테 나눠 맡겼어요.')
  expect(Array.from(line).length).toBeLessThanOrEqual(60)
  expect((await o.named('도윤'))?.label).toBe('리니어 담당')
  expect(o.task.team!.members.map(m => [m.role, m.topic, m.lookup, m.background])).toEqual([['지민', '노션', true, true], ['서연', '슬랙', true, true], ['도윤', '리니어', true, true]])
})

test('c4 C3/H5: a teammate whose time ran out with results in hand has their part written from what they read; a stop keeps nothing', async () => {
  const read = '노션 3.0 출시: AI 회의록이 추가됐어요, 2026.11.12. https://www.notion.com/releases/3-0\n슬랙 허들 요약 공개: 2026.11.10. https://slack.com/blog/huddles'
  const cutShort = part('m1', '지민', '노션 신기능 조사', { state: 'working', topic: '노션' })
  settleMember(cutShort, { answer: '', timedOut: true, read, sources: ['https://search.naver.com/search.naver?query=notion'] }, 'now', true)
  expect(cutShort).toMatchObject({ state: 'done', read: true })
  const done = part('m2', '서연', '슬랙 신기능 조사', { topic: '슬랙', result: '슬랙이 허들 요약을 냈어요. https://slack.com/blog/huddles' })
  // The host's own table: his row has what he read and its link, never "못 찾았어요", and no word about the cut.
  const table = mergedReport([cutShort, done])
  const row = table.split('\n').find(line => line.startsWith('| 노션 (지민) |'))!
  expect(row).toContain('노션 3.0 출시')
  expect(row).toContain('[notion.com](https://www.notion.com/releases/3-0)')
  expect(table).not.toMatch(/못 찾았어요|한도|멈춤|여기까지|더 있을 수/)
  // The writer is given the same material, told what it is, and its links pass the host's check exactly as a memo's do.
  const prompt = reportPrompt('노션, 슬랙 신기능 조사해서 알려줘', [cutShort, done])
  expect(prompt).toContain('"read":true')
  expect(prompt).toContain('https://www.notion.com/releases/3-0')
  expect(prompt).not.toMatch(/"cut"|한도에서 멈춤/)
  const written = '둘 다 찾아왔어요.\n\n| 맡은 일 (담당) | 내용과 출처 |\n|---|---|\n| 노션 (지민) | AI 회의록이 추가됐어요. [Notion 릴리스](https://www.notion.com/releases/3-0) |\n| 슬랙 (서연) | 허들 요약이 나왔어요. [Slack 블로그](https://slack.com/blog/huddles) |'
  expect(checkedReport(written, [cutShort, done])).toBe(written)
  expect(checkedReport(written.replace('둘 다 찾아왔어요.', '둘 다 찾아왔어요. 더 있을 수 있어요.'), [cutShort, done])).toBeUndefined()
  // A hand-off goes on from it (H5): the second teammate gets what was read, and the one bubble names both with the first one's link.
  const first = part('m1', '지민', '이번 주말 서울 날씨 찾기', { state: 'working', background: true, then: { botId: 'bot-m2', who: '서연', brief: '주말 나들이 추천 문구 한 줄 쓰기' } })
  settleMember(first, { answer: '검색 결과를 열 수 없었습니다.', timedOut: true, read: '토요일 서울 맑음, 최고 12도: 2026.11.21. https://weather.example/seoul' }, 'now', true)
  expect(first.state).toBe('done')
  const second = part('m2', '서연', handoffBrief(first.then!.brief, '지민', first.result!, first.brief, first.sources), { background: true, lookup: undefined, writer: true, result: '맑은 토요일, 가볍게 한강 나들이 어때요?' })
  expect(mergedReport([first, second])).toBe('서연이 지민의 이번 주말 서울 날씨로 주말 나들이 추천 문구 한 줄 썼어요.\n\n맑은 토요일, 가볍게 한강 나들이 어때요?\n\n지민이 찾은 내용: 토요일 서울 맑음, 최고 12도: 2026.11.21. · [weather.example](https://weather.example/seoul)')
  // Nothing read at all: one line that names both and says what is missing, once.
  const empty = { ...first, read: undefined, state: 'failed' as const, result: 'Failed: it ran out of time before it reported anything.' }
  expect(mergedReport([empty])).toBe('지민이 이번 주말 서울 날씨를 아직 못 찾아서, 서연한테는 못 넘겼어요.')
  // "멈춰": stopped, and nothing of what was read is kept (rule 4).
  const stopped = part('m3', '도윤', '리니어 조사', { state: 'working' })
  settleMember(stopped, { answer: '', error: 'it was stopped.', read }, 'now', true)
  expect(stopped).toMatchObject({ state: 'failed', result: 'Failed: it was stopped.' })
  expect(stopped.read).toBeUndefined()
  expect(JSON.stringify(stopped)).not.toContain('노션 3.0')
})

test('c4 C6: N short things asked for come back as a numbered list of N, from the host and from the writer', () => {
  for (const [brief, n] of [['홍보 문구 3개 뽑기', 3], ['장점 3가지 정리', 3], ['소개 글 세 줄 쓰기', 3], ['후보 두 개 고르기', 2], ['문구 한 줄 쓰기', 0], ['12월 행사 일정 정리', 0], ['노션 신기능 조사', 0]] as const) expect(askedCount(brief), brief).toBe(n)
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개 뽑기' }, result: '소프트웨이브 2026: 12월 2일~4일 https://example.com/sw' })
  const lines = ['"12월 2일, 서울에서 만나요"', '"비즈니스 데이부터 참관객의 날까지"', '"올해 서울 IT 행사의 하이라이트"']
  const park = part('m2', '서연', handoffBrief('홍보 문구 3개 뽑기', '지민', kim.result!, kim.brief), { background: true, lookup: undefined, writer: true, result: lines.join('\n\n') })
  const own = mergedReport([kim, park])
  expect(own.split('\n\n')[0]).toBe('서연이 지민의 다음 달 서울 IT 행사 일정 정리로 홍보 문구 3개 뽑았어요.')
  expect(own.split('\n').filter(line => /^\d\. /.test(line))).toEqual(lines.map((line, i) => `${i + 1}. ${line}`))
  expect(own.split('\n\n').at(-1)).toBe('지민이 찾은 내용: 소프트웨이브 2026: 12월 2일~4일 · [example.com](https://example.com/sw)')
  // The writer is handed the list as a list, and three bare paragraphs back from it are refused (the host's list stands in).
  expect(reportPrompt('문구 뽑아줘', [kim, park])).toContain('1. \\"12월 2일, 서울에서 만나요\\"\\n2. ')
  const tail = '지민이 찾은 내용: 12월 2일~4일에 열려요. [소프트웨이브](https://example.com/sw)'
  expect(checkedReport(['서연이 뽑았어요.', ...lines, tail].join('\n\n'), [kim, park])).toBeUndefined()
  // A numbered answer passes, and opens with the host's own sentence whatever the writer put first.
  expect(checkedReport(['서연이 뽑았어요.', lines.map((line, i) => `${i + 1}. ${line}`).join('\n'), tail].join('\n\n'), [kim, park])?.split('\n')[0]).toBe('서연이 지민의 다음 달 서울 IT 행사 일정 정리로 홍보 문구 3개 뽑았어요.')
})

test('c4 C7: "내 일정 뭐 있어?" is answered from the stored schedules, and "그거 취소해" right after means that one', () => {
  const kept = (id: string, goal: string, days: number[], hour: number): BotTask => ({ id, name: goal, goal, schedule: { days, hour, minute: 0 } } as BotTask)
  const weekly = kept('a', '지난주 팀이 한 일 요약해줘', [1], 9)
  for (const ask of ['내 일정 뭐 있어?', '일정 뭐 있어', '내 스케줄 알려줘']) expect(isDutyListAsk(ask), ask).toBe(true)
  for (const ask of ['내일 일정 정리해줘', '매주 월요일 9시에 요약해줘', '일정표 만들어줘']) expect(isDutyListAsk(ask), ask).toBe(false)
  expect(dutyList([])).toBe('아직 없어요.')
  expect(dutyList([weekly, { id: 'r', name: 'x', goal: 'x', routineId: 'r1', schedule: { days: [1], hour: 8, minute: 0 } } as BotTask, { id: 'n', name: 'y', goal: 'y' } as BotTask])).toBe('매주 월요일 9시에 지난주 팀이 한 일 요약하는 거 하나 있어요.')
  expect(dutyList([weekly, kept('b', 'AI 뉴스 정리해줘', [0, 1, 2, 3, 4, 5, 6], 18)])).toBe('일정은 2개 있어요.\n\n- 매주 월요일 9시: 지난주 팀이 한 일 요약\n- 매일 오후 6시: AI 뉴스 정리')
  // Cancel: only one schedule, and the reply just before named it (the list above, or the line that confirmed it).
  expect(dutyToCancel('그거 취소해', [weekly], dutyList([weekly]))).toBe(weekly)
  expect(dutyToCancel('그 일정 없애줘', [weekly], '매주 월요일 9시에 지난주 팀이 한 일 요약해 드릴게요.')).toBe(weekly)
  expect(dutyToCancel('그거 취소해', [weekly], '지민한테 맡겼어요.')).toBeUndefined()
  expect(dutyToCancel('그거 취소해', [weekly], undefined)).toBeUndefined()
  expect(dutyToCancel('그거 취소해', [weekly, kept('b', 'AI 뉴스 정리해줘', [1], 18)], dutyList([weekly]))).toBeUndefined()
  expect(dutyToCancel('그 회의 취소해', [weekly], dutyList([weekly]))).toBeUndefined()
})

test('c4 C8/C2: taking one teammate off and renaming one is the agents call itself, answered in one sentence; "서연도" is answered "서연도"', async () => {
  const staff = ['지민', '서연']
  expect(plainChange('서연은 빼고 지민은 이름을 지우로 바꿔', staff)).toEqual({ remove: ['서연'], rename: [{ who: '지민', name: '지우' }] })
  expect(plainChange('지민이 이름을 지우로 바꾸고 서연이는 빼줘', staff)).toEqual({ remove: ['서연'], rename: [{ who: '지민', name: '지우' }] })
  expect(plainChange('서연은 빼줘', staff)).toEqual({ remove: ['서연'] })
  expect(plainChange('지민 이름 지우로 바꿔줘.', staff)).toEqual({ rename: [{ who: '지민', name: '지우' }] })
  // Someone unknown, a name already taken, a role change, two removals, a file: the model's call.
  for (const ask of ['도윤은 빼줘', '지민은 이름을 서연으로 바꿔', '지민은 디자인 담당으로 바꿔', '지민은 빼고 서연은 빼줘', '표에서 지민 이름을 지우로 바꿔서 저장해줘', '서연은 빼고 지민한테 이거 맡겨']) expect(plainChange(ask, staff), ask).toBeUndefined()
  const o = await company()
  expect(await o.run({ add: [{ name: '지민', role: '리서치 담당' }] })).toBe('지민을 리서치 담당으로 추가했어요.')
  expect(await o.run(plainHire('서연도 추가해줘. 카피 담당이야')!)).toBe('서연도 카피 담당으로 넣었어요.')
  const kim = (await o.named('지민'))!
  expect(await o.run(plainChange('서연은 빼고 지민은 이름을 지우로 바꿔', staff)!)).toBe('서연은 뺐고, 지민은 이제 지우예요.')
  // Same person under the new name, and the one taken off is kept and comes back when called.
  expect((await o.named('지우'))?.id).toBe(kim.id)
  expect((await loadArchivedBots(o.paths)).map(bot => bot.name)).toEqual(['서연'])
  expect(await o.run({ remove: ['지우'] })).toBe('지우는 뺐어요. 다시 부르면 돌아와요.')
})

import { plainSteer, steerSplit } from '../src/company-tools.js'

test('c4b r2: a teammate cut short with only English search rows shows no English run in the host table; the link stays and the writer is still asked', async () => {
  const kim = part('m1', '지민', '노션 신기능 조사', { topic: '노션', read: true, result: 'Agents rebuilt to do more for less: New workspace controls https://www.notion.com/releases', sources: ['https://search.example/?q=notion'] })
  const park = part('m2', '서연', '슬랙 신기능 조사', { topic: '슬랙', result: '슬랙이 캔버스 공유를 냈어요 https://slack.com/blog' })
  const alone = mergedReport([kim])
  expect(alone).toBe('지민이 영어로 된 자료만 찾았어요.\n\n[notion.com](https://www.notion.com/releases)')
  const table = mergedReport([kim, park])
  expect(table).toContain('| 노션 (지민) | 영어로 된 자료만 찾았어요 · [notion.com](https://www.notion.com/releases) |')
  for (const text of [alone, table]) expect(text.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(/(?:[A-Za-z][A-Za-z'’-]*[\s,:]+){3,}[A-Za-z]/)
  // The quick model can say it in Korean, so it is asked; an English ask keeps its English result.
  const write = vi.fn(async () => '지민이 노션 신기능 조사해 왔어요.\n\n- 에이전트가 더 적은 비용으로 더 많이 해요. [Notion](https://www.notion.com/releases)')
  expect(await writtenReport({ ask: '노션 신기능 조사해줘', members: [kim], write })).toContain('에이전트가 더 적은 비용으로')
  expect(write).toHaveBeenCalledOnce()
  expect(mergedReport([part('m1', 'Kim', 'Look up Notion news', { result: 'Agents rebuilt to do more for less https://www.notion.com/releases' })])).toContain('Agents rebuilt to do more for less')
})

test('c4b r2: a written answer that drops a dated item the teammate listed is refused, and the host lists them all', async () => {
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { result: '12월 2일 소프트웨이브 https://example.com/a\n12월 5일 개발자 행사 https://example.com/b\n12월 9일 AI 행사 https://example.com/c', sources: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'] })
  const one = '지민이 정리했어요.\n\n- 12월 2일 소프트웨이브 [출처](https://example.com/a)'
  expect(checkedReport(one, [kim])).toBeUndefined()
  const all = '지민이 정리했어요.\n\n- 12/2 소프트웨이브 [출처](https://example.com/a)\n- 12월 5일 개발자 행사\n- 2026-12-09 AI 행사'
  expect(checkedReport(all, [kim])).toBe(all.replace('지민이 정리했어요.', '지민이 다음 달 서울 IT 행사 일정 정리해 왔어요.'))
  const said = await writtenReport({ ask: kim.brief, members: [kim], write: async () => one })
  for (const day of ['12월 2일', '12월 5일', '12월 9일']) expect(said).toContain(day)
  // One dated line, or lines with no day, are not counted.
  expect(checkedReport('지민이 정리했어요. 소프트웨이브가 열려요. [출처](https://example.com/a)', [{ ...kim, result: '12월 2일 소프트웨이브 https://example.com/a\n입장은 무료예요' }])).toBeDefined()
})

test('c4b r2: words said while a split works are read as a change to it: add, swap, take off; anything else is not', () => {
  const brief = (thing: string) => `이번 주 ${thing} 신기능 조사해서 알려줘`
  const split = (states: TeamMember['state'][] = ['working', 'working', 'working']): DelegatedTask => task({ id: 't1', botId: 'lead', state: 'waiting', team: { hires: 3, maxHires: 8, maxDepth: 2, big: false, members: [
    part('m1', '지민', brief('노션'), { topic: '노션', background: true, state: states[0]! }), part('m2', '서연', brief('슬랙'), { topic: '슬랙', background: true, state: states[1]! }), part('m3', '도윤', brief('리니어'), { topic: '리니어', background: true, state: states[2]! }),
  ] } })
  const steer = (words: string, t = split()) => plainSteer(words, [t], 'lead')
  expect(steer('아 피그마도 추가해')).toEqual({ taskId: 't1', said: '피그마도 넣을게요.', add: { role: '지민', botId: 'bot-m1', brief: brief('피그마'), topic: '피그마' } })
  expect(steer('그리고 제주도도 같이 알아봐줘.')?.add?.topic).toBe('제주도')
  expect(steer('그냥 슬랙 말고 지라로 바꿔')).toEqual({ taskId: 't1', said: '슬랙 말고 지라로 바꿀게요.', stop: 'm2', add: { role: '서연', botId: 'bot-m2', brief: brief('지라'), topic: '지라' } })
  expect(steer('슬랙을 팀즈로 바꿔줘')?.said).toBe('슬랙 말고 팀즈로 바꿀게요.')
  expect(steer('리니어 대신 지라')?.add).toMatchObject({ role: '도윤', topic: '지라' })
  expect(steer('리니어는 빼줘')).toEqual({ taskId: 't1', said: '리니어는 뺄게요.', stop: 'm3' })
  // Not a change to this split: another thread, nobody still working, a part it already has, a part it never had, a new teammate with a duty, an unrelated ask, going outside.
  expect(plainSteer('피그마도 추가해', [split()], 'other')).toBeUndefined()
  expect(steer('피그마도 추가해', split(['done', 'done', 'done']))).toBeUndefined()
  for (const words of ['노션도 추가해', '지라 말고 피그마로 바꿔', '하준도 추가해줘. 디자인 담당이야', '1년은 몇 초야?', '고마워 수고했어', '피그마도 슬랙에 올려줘']) expect(steer(words), words).toBeUndefined()
  // A fifth part, or the last two cut to one, is not the host's call.
  const four = split(); steerSplit(four, steer('피그마도 추가해', four)!)
  expect(steer('지라도 추가해', four)).toBeUndefined()
  expect(steer('피그마는 빼줘', four)?.stop).toBe('m4')

  // The change on the task: the part taken off leaves no row, the new one is a background lookup of the same shape.
  const t = split(['working', 'done', 'working'])
  t.team!.members[1]!.result = '슬랙이 캔버스를 냈어요 https://slack.com/blog'
  expect(steerSplit(t, steer('슬랙 말고 지라로 바꿔', t)!, 'now')).toEqual({ ids: ['m4'], stop: ['m2'] })
  expect(t.team!.members[1]).toMatchObject({ state: 'released' })
  expect(t.team!.members[1]!.result).toBeUndefined()
  expect(t.team!.members[3]).toMatchObject({ id: 'm4', role: '서연', botId: 'bot-m2', topic: '지라', brief: brief('지라'), lookup: true, background: true, state: 'hired', sessionKey: 'team-t1-m4' })
  expect(t.team!.hires).toBe(4)
  for (const m of t.team!.members) if (m.state !== 'released') { m.state = 'done'; m.result = `${m.topic} 새 기능이 나왔어요 https://example.com/${m.id}` }
  const rows = employeesReport(t)!.split('\n').filter(row => row.startsWith('| ')).slice(1)
  expect(rows.map(row => row.split(' | ')[0])).toEqual(['| 노션 (지민)', '| 리니어 (도윤)', '| 지라 (서연)'])
  // A split that ended before the change could be made is left alone.
  const ended = split(['done', 'done', 'done'])
  expect(steerSplit(ended, { taskId: 't1', said: '', add: { role: '지민', botId: 'bot-m1', brief: brief('지라'), topic: '지라' } })).toBeUndefined()
  expect(ended.team!.members).toHaveLength(3)
})

test('c4b r3: three events on one day are three items: the writer keeping one of them is refused, and the host lists all three', async () => {
  const kim = part('m1', '지민', '서울 IT 행사 일정 정리', { result: '12월 2일 행사 A https://example.com/a\n12월 2일 행사 B https://example.com/b\n12월 2일 행사 C https://example.com/c', sources: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'] })
  expect(checkedReport('지민이 정리했어요.\n\n- 12월 2일 행사 A [출처](https://example.com/a)', [kim])).toBeUndefined()
  expect(checkedReport('지민이 정리했어요.\n\n- 12월 2일 행사 A\n- 12월 2일 행사 B\n- 12월 2일 행사 C [출처](https://example.com/a)', [kim])).toContain('행사 C')
  const shown = await writtenReport({ ask: '서울 IT 행사 일정 정리해줘', members: [kim], write: async () => '지민이 정리했어요.\n\n- 12월 2일 행사 A [출처](https://example.com/a)' })
  for (const event of ['행사 A', '행사 B', '행사 C']) expect(shown).toContain(event)
})

// stack-4, from the c4b targeted run (runs/c4b-381043c9/C5.txt, C6.txt).
test('stack-4: a written answer with raw addresses or a line that is only the name is not shown, and no dash is left where an address was', async () => {
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { result: '- 소프트웨이브 2026: 12월 2일(수)~12월 4일(금), 서울 코엑스 Hall A — https://www.coex.co.kr/a\n- ACC 2026: 12월 개최 — https://itsight.zdnet.co.kr/acc2026/main.html', sources: ['https://search.naver.com/search.naver?query=x'] })
  const raw = '지민이 다음 달 서울 IT 행사 일정을 찾아봤어요.\n\n**지민**\n- 소프트웨이브 2026: 12월 2일(수)~12월 4일(금) — https://www.coex.co.kr/a\n- ACC 2026: 12월 개최 — https://itsight.zdnet.co.kr/acc2026/main.html'
  expect(checkedReport(raw, [kim])).toBeUndefined()
  expect(checkedReport(raw.replace('**지민**\n', ''), [kim])).toBeUndefined()
  expect(checkedReport('지민이 정리해 왔어요.\n\n- 소프트웨이브 2026: 12월 2일(수)~12월 4일(금) [코엑스](https://www.coex.co.kr/a)\n- ACC 2026: 12월 개최 [ACC](https://itsight.zdnet.co.kr/acc2026/main.html)', [kim])).toContain('[코엑스](https://www.coex.co.kr/a)')
  const shown = await writtenReport({ ask: '다음 달 서울 IT 행사 일정 정리', members: [kim], write: async () => raw })
  expect(shown).toContain('서울 코엑스 Hall A')
  expect(shown).toContain('](https://www.coex.co.kr/a)')
  expect(shown).not.toMatch(/—\s*($|\n|·)|\*\*지민|(?<!\]\()https?:\/\//m)
})

// c4b review r3 #1 (stack-4): the count left out a teammate cut short, whose result is what it read.
test('stack-4: a teammate cut short on a schedule job still has every dated item counted; a lookup that read a ten-day box does not', async () => {
  const one = '지민이 정리했어요.\n\n- 12월 2일 행사 A [출처](https://example.com/a)'
  const kim = part('m1', '지민', '서울 IT 행사 일정 정리', { read: true, result: '12월 2일 행사 A https://example.com/a\n12월 2일 행사 B https://example.com/b\n12월 2일 행사 C https://example.com/c', sources: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'] })
  expect(checkedReport(one, [kim])).toBeUndefined()
  const shown = await writtenReport({ ask: '서울 IT 행사 일정 정리', members: [kim], write: async () => one })
  for (const event of ['행사 A', '행사 B', '행사 C']) expect(shown).toContain(event)
  // Not a schedule or a list: the days of a forecast box nobody asked for are not required of the answer.
  const box = part('m2', '지민', '이번 주말 서울 날씨 찾기', { read: true, result: '11월 21일 맑음 8도\n11월 22일 흐림 6도\n11월 23일 비 5도\nhttps://example.com/w', sources: ['https://example.com/w'] })
  expect(checkedReport('지민이 찾아 왔어요.\n\n주말인 11월 21일은 맑고 8도예요. [출처](https://example.com/w)', [box])).toContain('맑고 8도')
})

test('c4b r3: a schedule cut short after its first event is still written with the events and addresses the teammate had read', () => {
  const kim = part('m1', '지민', '서울 IT 행사 일정 정리', { state: 'working' })
  settleMember(kim, { answer: '12월 2일 소프트웨이브', timedOut: true, read: '12월 2일 소프트웨이브 https://example.com/a\n12월 5일 개발자 행사 https://example.com/b\n12월 9일 AI 행사 https://example.com/c' }, 'now', true)
  const shown = mergedReport([kim])
  for (const event of ['소프트웨이브', '12월 5일 개발자 행사', '12월 9일 AI 행사']) expect(shown).toContain(event)
  expect(shown).toContain('](https://example.com/a)')
  expect(shown).not.toMatch(/한도|여기까지/)
  const data = JSON.parse(reportPrompt('서울 IT 행사 일정 정리해줘', [kim]).split('Data: ')[1]!) as { text: string; read?: boolean; pages: string[] }[]
  expect(data[0]).toMatchObject({ read: true, pages: ['https://example.com/a'] })
  expect(data[0]!.text).toContain('12월 9일 AI 행사 https://example.com/c')
})

test('c4b r3: with no written answer, a part that read only English pages is said in Korean by one small second ask, with its link', async () => {
  const kim = part('m1', '지민', '노션 신기능 조사', { topic: '노션', read: true, result: 'Agents rebuilt to do more for less: New workspace controls https://www.notion.com/releases', sources: ['https://www.notion.com/releases'] })
  const park = part('m2', '서연', '슬랙 신기능 조사', { topic: '슬랙', result: '슬랙이 캔버스 공유를 냈어요 https://slack.com/blog' })
  const asked: string[] = []
  // The first text is refused (an English sentence); the second ask is only about 지민.
  const write = (second: string) => async (prompt: string): Promise<string> => { asked.push(prompt); return asked.length === 1 ? 'Agents rebuilt to do more for less' : second }
  const alone = await writtenReport({ ask: '노션 신기능 조사해줘', members: [kim], write: write('지민: 노션이 Agents를 더 적은 비용으로 더 많이 하도록 다시 만들었고, 워크스페이스 관리 기능도 새로 냈어요.') })
  expect(alone).toBe('지민이 노션 신기능 조사해 왔어요.\n\n노션이 Agents를 더 적은 비용으로 더 많이 하도록 다시 만들었고, 워크스페이스 관리 기능도 새로 냈어요.\n\n[notion.com](https://www.notion.com/releases)')
  expect(asked[1]).toContain('New workspace controls')
  expect(asked[1]).not.toContain('슬랙')
  asked.length = 0
  const table = await writtenReport({ ask: '노션, 슬랙 신기능 조사해줘', members: [kim, park], write: write('- 지민: 노션이 워크스페이스 관리 기능을 새로 냈어요.') })
  expect(table).toContain('| 노션 (지민) | 노션이 워크스페이스 관리 기능을 새로 냈어요. · [notion.com](https://www.notion.com/releases) |')
  expect(table).not.toContain('영어로 된 자료만')
  // A second text that is still English, or names nobody, leaves the labelled line and its link: English is never shown.
  for (const bad of ['지민: Agents rebuilt to do more for less', 'New workspace controls', '']) {
    asked.length = 0
    expect(await writtenReport({ ask: '노션 신기능 조사해줘', members: [kim], write: write(bad) })).toBe('지민이 영어로 된 자료만 찾았어요.\n\n[notion.com](https://www.notion.com/releases)')
  }
  // Nothing English-only: no second ask.
  asked.length = 0
  await writtenReport({ ask: '슬랙 신기능 조사해줘', members: [park], write: write('') })
  expect(asked).toHaveLength(1)
})

// --- grokbar cycle 5 (c5b) ---
import { lateParts, lateShown, markLate, teamAnswer, teamSummary } from '../src/company-tools.js'
const SEARCHED = 'https://search.naver.com/search.naver?query=%EB%A6%AC%EB%8B%88%EC%96%B4%20%EC%8B%A0%EA%B8%B0%EB%8A%A5'
const teamTask = (members: TeamMember[], over: Partial<DelegatedTask> = {}): DelegatedTask => ({ ...task({ id: 'job', botId: 'lead', state: 'running', goal: '맡긴 일', ...over }), team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })
const unlinked = (text: string): string => text.replace(/\]\(https?:\/\/[^)\s]*\)/g, ')')

test('c5 C5: an address ending in .html is not a file, so the result is the host\'s to write; a file a teammate made is still the lead\'s', async () => {
  // The result as stored in the stack-4 run: the second address was kept as a file and the main model wrote the bubble.
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { state: 'working', background: true })
  settleMember(kim, { answer: '12월 4일: 소프트웨이브 2026, 코엑스 홀A, 입장 무료 — https://www.coex.co.kr/exhibitions/%EC%A0%9C11%ED%9A%8C/\n\n12월(일자 미확인): ACC 2026 — AI·클라우드 행사 — https://itsight.zdnet.co.kr/acc2026/main.html', sources: ['https://search.naver.com/search.naver?query=it'] }, 'now', true)
  expect(kim.files).toBeUndefined()
  const asked: string[] = []
  const said = (await employeesAnswer(teamTask([kim]), async prompt => { asked.push(prompt); return undefined }))!
  expect(asked).toHaveLength(1)
  expect(said.split('\n')[0]).toBe('지민이 다음 달 서울 IT 행사 일정 정리해 왔어요.')
  expect(said).toContain('소프트웨이브 2026')
  expect(said).toContain('](https://itsight.zdnet.co.kr/acc2026/main.html)')
  expect(unlinked(said)).not.toMatch(/https?:\/\//)
  // A document made in the workspace is a file: the lead writes that report, as before.
  const park = part('m2', '서연', '보고서 만들기', { state: 'working', background: true, lookup: false })
  settleMember(park, { answer: '보고서를 만들었어요. reports/3분기.docx 에 있어요.' }, 'now', true)
  expect(park.files).toEqual(['reports/3분기.docx'])
  expect(await employeesAnswer(teamTask([park]))).toBeUndefined()
  // What the lead then writes is repaired where it stands: the host's list cannot hand over the file.
  expect(teamAnswer('서연이 보고서를 만들었어요.\n\n서연\n\n[3분기.docx](engram-artifact:a.docx) 참고: https://example.com/guide', teamTask([park]))).toBe('서연이 보고서를 만들었어요.\n\n[3분기.docx](engram-artifact:a.docx) 참고: [example.com](https://example.com/guide)')
})

test('c5 C5: a team result the main model wrote with raw addresses, a name-only line or bare hosts gives way to the host\'s list', () => {
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { background: true, result: '12월 4일: 소프트웨이브 2026, 코엑스 — https://www.coex.co.kr/sw\n12월: ACC 2026 — https://itsight.zdnet.co.kr/acc2026/main.html' })
  const job = teamTask([kim])
  // The bubble of the stack-4 run.
  const raw = '지민이 다음 달 서울 IT 행사를 조사했어요.\n\n지민\n\n소프트웨이브 2026 — 12/2(수)~12/4(금)\nhttps://www.coex.co.kr/sw\n\nACC 2026은 정확한 날짜를 못 찾았다고 해요.\n\ncoex.co.kr\nitsight.zdnet.co.kr'
  const shown = teamAnswer(raw, job)
  expect(shown).toBe(mergedReport([kim]))
  expect(shown).toContain('[coex.co.kr](https://www.coex.co.kr/sw)')
  expect(unlinked(shown)).not.toMatch(/https?:\/\//)
  expect(shown).not.toContain('못 찾았다고')
  expect(shown.split('\n')).not.toContain('지민')
  // Each of the three alone is enough.
  for (const bad of ['지민이 찾았어요.\n\n**지민**\n\n행사는 12월 4일이에요.', '행사는 12월 4일이에요.\n\ncoex.co.kr', '행사는 12월 4일이에요. https://www.coex.co.kr/sw']) expect(teamAnswer(bad, job)).toBe(mergedReport([kim]))
  // A clean answer stands; links that follow each other are set apart (C6: "소프트웨이브 2026 ACC 2026").
  expect(teamAnswer('지민이 찾은 내용: 12월에 열려요. [소프트웨이브 2026](https://www.coex.co.kr/sw) [ACC 2026](https://itsight.zdnet.co.kr/acc2026/main.html)', job)).toBe('지민이 찾은 내용: 12월에 열려요. [소프트웨이브 2026](https://www.coex.co.kr/sw) · [ACC 2026](https://itsight.zdnet.co.kr/acc2026/main.html)')
  // Not a team result: left as it is.
  expect(teamAnswer('https://example.com 을 보세요.', task({ state: 'running' }))).toBe('https://example.com 을 보세요.')
  expect(teamAnswer('https://example.com 을 보세요.', undefined)).toBe('https://example.com 을 보세요.')
})

test('c5 C3: a teammate who looked and found nothing new keeps what they read, and their row says so with a link to where they looked', async () => {
  const said = '검색 결과에 리니어(Linear) 관련 신기능 소식이 전혀 없네요. 엉뚱한 뉴스·기업 공시 자료만 나와서 관련 정보를 찾지 못했어요.'
  const rows = '어느 회사 3분기 공시: 매출이 늘었다, 11월 14일 https://example.com/ir\n리니어 10월 업데이트 정리: 프로젝트 보기가 바뀌었다, 10월 28일 https://example.com/linear-oct'
  const doyun = part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', state: 'working', background: true })
  settleMember(doyun, { answer: said, read: rows, sources: [SEARCHED] }, 'now', true)
  expect(doyun).toMatchObject({ state: 'done', read: true, empty: true })
  expect(doyun.result).toContain('https://example.com/linear-oct')
  const kim = part('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', { topic: '노션', background: true, result: '노션이 AI 회의록을 냈어요 https://notion.so/releases' })
  // The host's own table: nothing new, and the result that names the part as a named link. Never the unrelated row, never "못 찾았어요".
  const table = mergedReport([kim, doyun])
  expect(table).toContain('| 리니어 (도윤) | 이번 주 새 소식은 안 보여요. [리니어 10월 업데이트 정리](https://example.com/linear-oct) |')
  expect(table).not.toMatch(/못 찾았어요|공시|검색 결과/)
  // No result names the part: the page they searched on.
  const plain = part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', state: 'working' })
  settleMember(plain, { answer: said, read: rows.split('\n')[0]!, sources: [SEARCHED] }, 'now', true)
  expect(mergedReport([kim, plain])).toContain(`| 리니어 (도윤) | 이번 주 새 소식은 안 보여요. [네이버 검색](${SEARCHED}) |`)
  expect(mergedReport([plain])).toBe(`도윤이 찾아봤는데, 이번 주 새 소식은 안 보여요. [네이버 검색](${SEARCHED})`)
  // No page was loaded at all: only then "못 찾았어요".
  const none = part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', state: 'working' })
  settleMember(none, { answer: said }, 'now', true)
  expect(none.empty).toBeUndefined()
  expect(mergedReport([kim, none])).toContain('| 리니어 (도윤) | 이번엔 못 찾았어요. |')
  // An answer that found something (it names its page) is not a found-nothing one, whatever else it says.
  const some = part('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', { state: 'working' })
  settleMember(some, { answer: '이번 주 신기능 발표는 없어요. 11월 2일 크레딧 정책만 바뀌었어요 https://example.com/credit', read: rows, sources: [SEARCHED] }, 'now', true)
  expect(some.empty).toBeUndefined()
  expect(some.result).not.toContain('linear-oct')
  // The writer is told, is given the pages to link, and its row is checked: a link is needed and "못 찾았어요" is refused.
  const data = JSON.parse(reportPrompt('경쟁사 신기능 조사', [kim, doyun]).split('Data: ')[1]!) as { nothing?: boolean; pages: string[] }[]
  expect(data[1]).toMatchObject({ nothing: true, pages: [SEARCHED, 'https://example.com/ir', 'https://example.com/linear-oct'] })
  const head = '둘이 찾아봤어요.\n\n| 맡은 일 (담당) | 내용과 출처 |\n|---|---|\n| 노션 (지민) | 노션이 AI 회의록을 냈어요. [노션 릴리스](https://notion.so/releases) |\n'
  expect(checkedReport(`${head}| 리니어 (도윤) | 이번엔 못 찾았어요. |`, [kim, doyun])).toBeUndefined()
  expect(checkedReport(`${head}| 리니어 (도윤) | 이번 주 새 소식은 안 보여요. |`, [kim, doyun])).toBeUndefined()
  const good = `${head}| 리니어 (도윤) | 이번 주 새 소식은 안 보여요. 가장 최근은 10월 28일 프로젝트 보기 개편이에요. [리니어 10월 업데이트](https://example.com/linear-oct) |`
  expect(checkedReport(good, [kim, doyun])).toBe(good)
  expect(await writtenReport({ ask: '경쟁사 신기능 조사', members: [kim, doyun], write: async () => good })).toBe(good)
})

test('c5 C4: "다들 뭐 하고 있어?" is a sentence or two: people in the same state together, a shared job once', async () => {
  const c = await company()
  await c.run({ add: [{ name: '지민', role: '리서치 담당' }] })
  const now = Date.parse('2026-11-16T01:10:00.000Z')
  const one = await loadBots(c.paths), kim = one.find(bot => bot.name === '지민')!.id
  const did = (id: string, botId: string, topic: string): TeamMember => member({ id, botId, state: 'released', brief: `이번 주 ${topic} 신기능 조사해서 알려줘`, topic, result: 'x', finishedAt: '2026-11-16T01:05:00.000Z' })
  // One teammate: one sentence.
  expect(companyStatus(one, [], now)).toBe('지민은 지금은 쉬고 있어요.')
  expect(companyStatus(one, [teamTask([did('m1', kim, '노션')], { state: 'done' })], now)).toBe('지민은 방금 이번 주 노션 신기능 조사를 끝내고 쉬고 있어요.')
  await c.run({ add: [{ name: '서연', role: '카피 담당' }, { name: '도윤', role: '리서치 담당' }] })
  const bots = await loadBots(c.paths), id = (name: string) => bots.find(bot => bot.name === name)!.id
  const split = teamTask([did('m1', id('지민'), '노션'), did('m2', id('서연'), '슬랙'), did('m3', id('도윤'), '리니어')], { state: 'done' })
  // Everyone idle: what the jobs share is said once.
  const idle = companyStatus(bots, [split], now)
  expect(idle).toBe('셋 다 지금은 쉬고 있어요. 방금 지민은 노션, 서연은 슬랙, 도윤은 리니어 신기능 조사를 끝냈어요.')
  expect(idle).not.toContain('\n')
  // Later the same work is not "방금".
  expect(companyStatus(bots, [split], now + 5 * 3_600_000)).toContain('마지막으로 지민은 노션,')
  // Mixed: who is on what first, the rest in one clause.
  const busy = teamTask([member({ id: 'm1', botId: id('지민'), state: 'working', brief: '다음 달 서울 IT 행사 일정 정리' })], { id: 'next', state: 'waiting' })
  expect(companyStatus(bots, [split, busy], now)).toBe('지민은 다음 달 서울 IT 행사 일정 정리하고 있고, 서연이랑 도윤은 쉬고 있어요.')
  // A job two people share is said once; a job named by a verb is said as one.
  const shared = teamTask([member({ id: 'm1', botId: id('지민'), state: 'working', brief: '경쟁사 조사' }), member({ id: 'm2', botId: id('서연'), state: 'working', brief: '경쟁사 조사' }), member({ id: 'm3', botId: id('도윤'), state: 'working', brief: '홍보 문구 3개 뽑기' })], { state: 'waiting' })
  expect(companyStatus(bots, [shared], now)).toBe('지민이랑 서연은 경쟁사 조사하고 있고, 도윤은 홍보 문구 3개 뽑고 있어요.')
  // Everyone finished the same job.
  const same = teamTask([member({ id: 'm1', botId: id('지민'), state: 'done', brief: '경쟁사 조사', finishedAt: '2026-11-16T01:05:00.000Z' }), member({ id: 'm2', botId: id('서연'), state: 'done', brief: '경쟁사 조사', finishedAt: '2026-11-16T01:05:00.000Z' })], { state: 'done' })
  expect(companyStatus(bots.filter(bot => bot.name !== '도윤'), [same], now)).toBe('지민이랑 서연은 방금 경쟁사 조사를 끝내고 쉬고 있어요.')
  // Every name and a word for the state are always there.
  for (const said of [idle, companyStatus(bots, [], now), companyStatus(bots, [split, busy], now)]) for (const name of ['지민', '서연', '도윤']) expect(said).toContain(name)
})

test('c5 C6: links that follow each other in a written answer are set apart', () => {
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { result: '소프트웨이브 https://a.example.com/sw\nACC https://b.example.com/acc' })
  expect(checkedReport('지민이 정리해 왔어요.\n\n12월에 둘 다 열려요. [소프트웨이브 2026](https://a.example.com/sw) [ACC 2026](https://b.example.com/acc)', [kim])).toContain('[소프트웨이브 2026](https://a.example.com/sw) · [ACC 2026](https://b.example.com/acc)')
  // Already set apart, or glued: one separator either way.
  expect(checkedReport('지민이 정리해 왔어요.\n\n[소프트웨이브 2026](https://a.example.com/sw)[ACC 2026](https://b.example.com/acc)', [kim])).toContain('sw) · [ACC')
  expect(checkedReport('지민이 정리해 왔어요.\n\n[소프트웨이브 2026](https://a.example.com/sw) · [ACC 2026](https://b.example.com/acc)', [kim])).not.toContain('· ·')
})

test('c5 C10: what the team did is written from the record by the quick model, checked by the host, with no round of the lead', async () => {
  const c = await company()
  await c.run({ add: [{ name: '지우', role: '리서치 담당' }, { name: '서연', role: '카피 담당' }] })
  const day = new Date('2026-11-16T03:00:00.000Z'), now = new Date(2026, 10, 18, 10)
  await recordFacts(c.paths, TEAM_MEMORY, [
    '이번 주 노션 신기능 조사 → 새 발표는 없었어요 https://example.com/n (지우, 2026-11-16)',
    '이번 주 슬랙 신기능 조사 → 세일즈포스 에이전트 스워밍 기능이 나왔어요 [슬랙](https://slack.com/x) (서연, 2026-11-16)',
    '홍보 문구 3개 뽑기 (지우한테 받아서) → 1. 코엑스에서 만나요 (서연, 2026-11-16)',
    '지난 분기 정리 → 표로 정리했어요 (지우, 2026-11-03)',
  ], day)
  // 서연 is taken off the team afterwards: their work is still named as theirs.
  await c.run({ remove: ['서연'] })
  const bots = await loadBots(c.paths), asked: string[] = []
  const good = '월요일에 지우가 노션 신기능을 살펴봤는데 새 발표는 없었고, 서연은 슬랙에서 세일즈포스 에이전트 스워밍 기능을 찾았어요. 서연이 지우 조사로 홍보 문구 3개도 썼어요.'
  expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async prompt => { asked.push(prompt); return good } })).toBe(good)
  // One small ask: the jobs of this week only, each with who and the day in words, no address.
  expect(asked).toHaveLength(1)
  expect(asked[0]!.length).toBeLessThan(3000)
  const record = JSON.parse(asked[0]!.split('Record: ')[1]!) as { who: string; did: string; got: string; day: string; from?: string }[]
  expect(record.map(job => [job.who, job.did, job.day])).toEqual([['지우', '이번 주 노션 신기능 조사', '월요일'], ['서연', '이번 주 슬랙 신기능 조사', '월요일'], ['서연', '홍보 문구 3개 뽑기', '월요일']])
  expect(record[2]!.from).toBe('지우')
  expect(asked[0]).not.toMatch(/https?:\/\/|2026-11/)
  expect(asked[0]).toContain('say that day once')
  // A text the person should not read gives way to the host's own sentence: a list, a raw day, an address, someone left out, nothing at all.
  const plain = '월요일에 지우는 이번 주 노션 신기능 조사, 서연은 이번 주 슬랙 신기능 조사랑 홍보 문구 3개 뽑기를 했어요.'
  for (const bad of ['- 지우: 노션 조사\n- 서연: 슬랙 조사', '지우와 서연이 2026-11-16에 조사했어요.', '지우와 서연이 조사했어요. https://example.com', '지우가 노션을 조사했어요.', '', undefined]) expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async () => bad })).toBe(plain)
  expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async () => { throw new Error('no') } })).toBe(plain)
  expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, timeoutMs: 10, write: () => new Promise(() => undefined) })).toBe(plain)
  // Nothing in the time asked is said by the host; the kept weekly ask ("지난주 …") reads last week.
  expect(await teamSummary(c.paths, { bots, message: '지난주 팀이 한 일 요약해줘', now, write: async () => good })).toBe('지난주에는 아직 팀이 끝낸 일이 없어요.')
  const later = JSON.parse((await (async () => { const seen: string[] = []; await teamSummary(c.paths, { bots, message: '매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘', now: new Date(2026, 10, 23, 9), write: async prompt => { seen.push(prompt); return good } }); return seen[0]! })()).split('Record: ')[1]!) as { day: string }[]
  expect(later.map(job => job.day)).toEqual(['11월 16일', '11월 16일', '11월 16일'])
  // With no quick model the lead answers from the record in its prompt.
  expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now })).toBeUndefined()
})

test('c5 rule 7: a part still at work when the others are reported is labeled there and reported alone afterwards', async () => {
  const kim = part('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', { topic: '노션', background: true, result: '노션이 AI 회의록을 냈어요 https://notion.so/releases' })
  const doyun = part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', background: true, state: 'working' })
  const job = teamTask([kim, doyun], { state: 'waiting' })
  expect(lateParts(job)).toEqual(['m3'])
  expect(markLate(job)).toEqual(['m3'])
  expect(lateParts(job)).toEqual([])
  const first = employeesReport(job)!
  expect(first).toContain('| 노션 (지민) | 노션이 AI 회의록을 냈어요 · [notion.so](https://notion.so/releases) |')
  expect(first).toContain('| 리니어 (도윤) | 아직 찾는 중이에요. 끝나면 이어서 올릴게요. |')
  // The writer is told, and a row that hides it is refused.
  const view = [kim, { ...doyun }]
  expect(JSON.parse(reportPrompt('조사', view).split('Data: ')[1]!)[1]).toMatchObject({ working: true, text: '' })
  expect(checkedReport('둘이 찾았어요.\n\n| 맡은 일 (담당) | 내용과 출처 |\n|---|---|\n| 노션 (지민) | 냈어요. [노션](https://notion.so/releases) |\n| 리니어 (도윤) | 이번엔 못 찾았어요. |', view)).toBeUndefined()
  // It lands before that report is read: the report still says what it promised.
  doyun.state = 'done'; doyun.result = '리니어가 새 보기를 냈어요 https://linear.app/changelog'
  expect(employeesReport(job)).toBe(first)
  // Once that report is in the thread, the next one is the late part alone.
  lateShown(job)
  expect(employeesReport(job)).toBe('도윤이 이번 주 리니어 신기능 조사해 왔어요.\n\n리니어가 새 보기를 냈어요\n\n[linear.app](https://linear.app/changelog)')
  // Nothing back yet, or a hand-off under way: nothing to report early.
  expect(lateParts(teamTask([{ ...kim, state: 'working', result: undefined }, { ...doyun, state: 'working', late: undefined }]))).toEqual([])
  expect(lateParts(teamTask([{ ...kim, then: { botId: 'b', who: '서연', brief: '문구' } }, part('m2', '서연', handoffBrief('문구 쓰기', '지민', 'x'), { background: true, state: 'working' })]))).toEqual([])
})

// c5b review r1: the C3 record kept no read text, only the page searched on, and the row still read "이번엔 못 찾았어요." with no link.
test('c5b r2 C3: a part that searched and kept no text still says where it looked, as a named link, and the writer may not drop that link', () => {
  const kim = part('m1', '지민', '이번 주 노션 신기능 조사', { background: true, lookup: true, topic: '노션', result: '노션이 새 보기를 냈어요 https://example.com/a' })
  const doyun = part('m3', '도윤', '이번 주 리니어 신기능 조사', { state: 'working', background: true, lookup: true, topic: '리니어' })
  settleMember(doyun, { answer: '관련 정보를 찾지 못했어요.', sources: ['https://search.naver.com/search.naver?query=linear'] }, 'now', true)
  expect(doyun.empty).toBe(true)
  const row = mergedReport([kim, doyun]).split('\n').find(line => line.includes('(도윤)'))!
  expect(row).toContain('이번 주 새 소식은 안 보여요.')
  expect(row).toContain('](https://search.naver.com/search.naver?query=linear)')
  expect(row).not.toContain('못 찾았')
  const table = (cell: string): string => `| 항목 | 내용 |\n| --- | --- |\n| 노션 (지민) | 새 보기를 냈어요. [example.com](https://example.com/a) |\n| 리니어 (도윤) | ${cell} |`
  expect(checkedReport(table('이번 주 새 소식은 안 보여요.'), [kim, doyun])).toBeUndefined()
  expect(checkedReport(table('이번 주 새 소식은 안 보여요. [네이버](https://search.naver.com/search.naver?query=linear)'), [kim, doyun])).toBeDefined()
})

// c5b review r1: "example.com/report.html" was kept as a file and shown as written.
test('c5b r2 C5: an address written without its scheme is not a file and never reaches the thread raw', () => {
  const kim = part('m1', '지민', '행사 조사', { state: 'working', background: true })
  settleMember(kim, { answer: 'example.com/report.html' }, 'now', true)
  expect(kim.files).toBeUndefined()
  const shown = teamAnswer('example.com/report.html', teamTask([kim]))
  expect(shown).toContain('[example.com](https://example.com/report.html)')
  expect(shown.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(/example\.com/)
  // Inside a sentence the main model wrote, with a file the host's list cannot carry: repaired where it stands, the full stop kept.
  const park = part('m2', '서연', '보고서 만들기', { state: 'working', background: true, lookup: false })
  settleMember(park, { answer: '보고서를 만들었어요. reports/3분기.docx 에 있어요.' }, 'now', true)
  expect(teamAnswer('서연이 만들었어요. [3분기.docx](engram-artifact:a.docx) 참고는 www.coex.co.kr/sw.', teamTask([park]))).toBe('서연이 만들었어요. [3분기.docx](engram-artifact:a.docx) 참고는 [coex.co.kr](https://www.coex.co.kr/sw).')
  // Words with a dot and a slash that are no address, a named link and a workspace file stand.
  for (const fine of ['node.js/express 로 만들었어요.', '[coex.co.kr/sw](https://www.coex.co.kr/sw) 에 있어요.', 'reports/q3.docx 에 있어요.']) expect(teamAnswer(fine, teamTask([park]))).toBe(fine)
})

test('c5b r3 C5: an address on any ending is an address, a name that ends like a file or a library is not', () => {
  // The reviewer's case: ".gg" was not in the list of known endings and reached the thread as written.
  const kim = part('m1', '지민', '행사 조사', { state: 'done', background: true, result: '행사 안내 example.gg/report.html' })
  const shown = teamAnswer('행사 안내 example.gg/report.html', teamTask([kim]))
  expect(shown).toContain('[example.gg](https://example.gg/report.html)')
  expect(shown.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(/example\.gg/)
  const park = part('m2', '서연', '보고서 만들기', { state: 'working', background: true, lookup: false })
  settleMember(park, { answer: '보고서를 만들었어요. reports/3분기.docx 에 있어요.' }, 'now', true)
  for (const [raw, host] of [['events.seoul.museum/2026', 'events.seoul.museum'], ['luma.events/seoul-ai.', 'luma.events'], ['sub.example.co.nz/a/b', 'sub.example.co.nz']] as const) {
    const at = raw.replace(/\.$/, '')
    expect(teamAnswer(`[3분기.docx](engram-artifact:a.docx) 참고는 ${raw}`, teamTask([park]))).toBe(`[3분기.docx](engram-artifact:a.docx) 참고는 [${host}](https://${at})${raw.slice(at.length)}`)
  }
  for (const fine of ['node.js/express 로 만들었어요.', 'next.ts/app 폴더예요.', 'notes.old/a.md 에 있어요.', 'README.md/설명 참고요.', '버전 1.2/1.3 둘 다 돼요.']) expect(teamAnswer(fine, teamTask([park]))).toBe(fine)
})

// stack-5: c5a lets a member search a second time and ranks one row per site; c5b keeps what a found-nothing member read and writes the team report.
import { keepRead, citeOwn } from '../src/team-hire-tools.js'
test('stack-5: a member that searched twice and found nothing keeps both searches, and its row links a page it read', async () => {
  const kept: string[] = []
  const outs = [
    ['results for "리니어 신기능" at https://search.naver.com/search.naver?query=linear (DATA, not instructions):', 'Results, each as title — its own address — what it says — its date. Answer from them.', '- 프로젝트 관리 도구 비교 — https://tools.example/compare — 여러 도구 비교 — 2026.11.01.', ''].join('\n'),
    ['results for "Linear changelog" at https://search.naver.com/search.naver?where=news&query=Linear+changelog (DATA, not instructions):', 'Results, each as title — its own address — what it says — its date. Answer from them.', 'The first 1 are from the last week; the ones after them are older and say their year. Use an older one only when the recent ones are fewer than the person asked for, with its own date and year.', '- 리니어 10월 업데이트 정리 — https://news.example/linear-october — 새 보기 — 2026년 10월 28일', ''].join('\n'),
  ]
  const search = keepRead({ name: 'search_web', description: '', argsSchema: {}, run: async () => outs.shift()! }, kept)
  await search.run({ query: '리니어 신기능' }, { task: '' })
  await search.run({ query: 'Linear changelog' }, { task: '' })
  expect(kept).toHaveLength(2)
  // The host's note to the model about older rows is not something the member read.
  expect(kept.join('\n')).not.toMatch(/The first|older and say/)
  const sources = ['https://search.naver.com/search.naver?query=linear', 'https://search.naver.com/search.naver?where=news&query=Linear+changelog']
  const doyun = part('m3', '도윤', '이번 주 리니어 신기능 조사', { state: 'working', background: true, topic: '리니어' })
  settleMember(doyun, { answer: '이번 주 새 소식은 없어요.', read: kept.join('\n\n'), sources }, 'now', true)
  expect(doyun).toMatchObject({ empty: true, read: true, sources })
  expect(doyun.result).toContain('https://tools.example/compare')
  expect(doyun.result).toContain('https://news.example/linear-october')
  const row = mergedReport([part('m1', '지민', '이번 주 노션 신기능 조사', { background: true, topic: '노션', result: '노션이 새 보기를 냈어요 https://example.com/a' }), doyun]).split('\n').find(line => line.includes('(도윤)'))!
  expect(row).toContain('이번 주 새 소식은 안 보여요. [리니어 10월 업데이트 정리](https://news.example/linear-october)')
  // With no result that names the part, the link is the page it searched on.
  const plain = part('m4', '도윤', '이번 주 리니어 신기능 조사', { state: 'working', background: true, topic: '리니어' })
  settleMember(plain, { answer: '이번 주 새 소식은 없어요.', read: '프로젝트 관리 도구 비교: 여러 도구 비교 https://tools.example/compare', sources }, 'now', true)
  expect(mergedReport([plain]).split('\n').find(line => line.includes('새 소식'))).toContain(`](${sources[0]})`)
})

test('stack-5: a team result never names a link "네이버 블로그", whoever wrote it, and the host\'s own list never does', () => {
  const kim = part('m1', '지민', '이번 주말 서울 날씨 조사', { background: true, topic: '서울', result: '주말은 맑아요. [주말 나들이 날씨 정리](https://blog.naver.com/traveltrap/1)', sources: ['https://search.naver.com/search.naver?query=seoul'] })
  const lee = part('m2', '서연', '부산 날씨 조사', { background: true, topic: '부산', result: '부산은 흐려요 https://cafe.naver.com/busan/2' })
  const written = '지민이랑 서연이 알아봤어요.\n\n| 항목 | 내용 |\n| --- | --- |\n| 서울 (지민) | 주말은 맑아요. [네이버 블로그](https://blog.naver.com/traveltrap/1) |\n| 부산 (서연) | 흐려요. [네이버 카페](https://cafe.naver.com/busan/2) |'
  const shown = teamAnswer(written, teamTask([kim, lee]))
  expect(shown).toContain('[주말 나들이 날씨 정리](https://blog.naver.com/traveltrap/1)')
  expect(shown).toContain('[커뮤니티 글](https://cafe.naver.com/busan/2)')
  for (const text of [shown, mergedReport([kim, lee])]) expect(text).not.toMatch(/네이버 (?:블로그|카페)/)
  // stack-5 (c5a run, R2): the place with the writer's id after it is still only the place.
  expect(teamAnswer(written.replace('[네이버 블로그]', '[네이버 블로그 traveltrap]'), teamTask([kim, lee]))).toContain('[주말 나들이 날씨 정리](https://blog.naver.com/traveltrap/1)')
  // A clean answer passes as it was.
  const clean = written.replace('네이버 블로그', '주말 나들이 날씨 정리').replace('네이버 카페', '부산 날씨')
  expect(teamAnswer(clean, teamTask([kim, lee]))).toBe(clean)
})

// stack-5 (c5a run, T2): "…하락했어요.\n\n[네이버 증권](…)\n\n---\n\n```replies" left the link on a line of its own.
test('stack-5: the lone link joins its sentence when a rule line stands before the suggested replies', () => {
  const tail = '\n\n---\n\n```replies\n52주 최고/최저도 알려줘\n엔비디아랑 비교해줘\n```'
  const link = '[네이버 증권](https://search.naver.com/search.naver?query=%EC%95%A0%ED%94%8C%20%EC%A3%BC%EA%B0%80)'
  expect(citeOwn(`애플은 11월 16일 종가 기준 352.78달러로 전일 대비 3.49달러(0.98%) 하락했어요.\n\n${link}${tail}`, [], true)).toBe(`애플은 11월 16일 종가 기준 352.78달러로 전일 대비 3.49달러(0.98%) 하락했어요. ${link}${tail}`)
  // A rule line inside the answer is not the replies' own.
  expect(citeOwn(`위\n\n---\n\n아래예요.\n\n${link}`, [], true)).toBe(`위\n\n---\n\n아래예요. ${link}`)
})

// stack-5 (c5a review r3): the member gave the blog post's address with no title and kept only the search page.
import { citeMembers } from '../src/team-hire-tools.js'
test('stack-5: a row whose member named a blog post by its address alone cites that post, not the search page', () => {
  const m = part('m1', '갤럭시 S27', '갤럭시 S27 가격', { botId: undefined as never, sources: ['https://search.naver.com/search.naver?query=Galaxy+S27+price'], result: '예상 130만 원 (https://blog.naver.com/example/1)' })
  const out = citeMembers('| 제품 | 가격 | 출처 |\n|---|---|---|\n| 갤럭시 S27 | 예상 130만 원 | 네이버 블로그 |', [m], true)
  expect(out).toContain('| [블로그 글](https://blog.naver.com/example/1) |')
  expect(out).not.toMatch(/네이버 (?:검색|블로그)/)
  // No post named: the member's page, as before.
  expect(citeMembers('| 제품 | 가격 | 출처 |\n|---|---|---|\n| 갤럭시 S27 | 예상 130만 원 | 네이버 블로그 |', [{ ...m, result: '예상 130만 원' }], true)).toContain('[네이버 검색](https://search.naver.com/search.naver?query=Galaxy+S27+price)')
})
