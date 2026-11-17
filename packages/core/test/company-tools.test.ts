import { beforeEach, expect, test, vi } from 'vitest'
import { loadBotMemory, recordFacts } from '../src/bot-memory.js'
import { appendBotTurn, createBot, loadArchivedBots, loadBots, readBotTranscript } from '../src/bots.js'
import { answersItself, checkedReport, writesFromHandover, employeesAnswer, isPartsAsk, jobTitle, reportPrompt, teamName, writtenReport, companyNote, companyStatus, companyStatusTool, isAssignAsk, isCompanyAsk, isDutyAsk, isOutsideAsk, plainHandoff, isStatusAsk, isTeamWorkAsk, staffTool, takesCompanyLane, teamRecord, TEAM_MEMORY } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { changeSidebarLayout, readSidebarLayout } from '../src/sidebar-layout.js'
import { MEMBER_BLOCKED } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// c6: what is shown depends on the day (a find dated outside the time asked says so). The stored results are of the week of 2026-11-17.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-17T03:00:00Z') }) })

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
  expect(kim).toMatchObject({ label: '리서치 담당', purpose: '자료를 찾아 출처와 함께 정리한다\n말투: 차분하고 또박또박' })
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
  expect(companyStatus(await loadBots(paths), [])).toBe('아직 지민이랑 서연한테 맡긴 일이 없어요.')
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
  expect(await named('지우')).toMatchObject({ id: kim.id, label: '리서치 담당', purpose: '조사한다\n말투: 차분하고 또박또박' })
  expect((await loadBotMemory(paths, kim.id)).facts.map(fact => fact.text).join()).toContain('노션')
  expect((await loadArchivedBots(paths)).map(bot => bot.id)).toEqual([park.id])
  expect((await loadBotMemory(paths, park.id)).facts).toHaveLength(1)
  expect(await readBotTranscript(paths, park.id)).toHaveLength(1)

  // grokbar H5: adding someone under a removed name brings the same agent back with the role just given (it was refused with the way back).
  expect(await run({ add: [{ name: '서연', role: '글 담당' }] })).toBe('서연은 글 담당으로 다시 불렀어요.')
  expect(await named('서연')).toMatchObject({ id: park.id, label: '글 담당', purpose: '글 담당\n말투: 밝고 시원시원하게' })
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
  expect(await named('지우')).toMatchObject({ id: kim.id, label: '뉴스 담당', purpose: '매일 아침 뉴스를 찾는다\n말투: 차분하고 또박또박' })
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
  expect(companyStatus(bots, tasks)).toBe('지민은 다음 달 서울 IT 행사 일정 정리하고 있고, 도윤은 리니어 신기능 조사하고 있고, 하린은 로고 시안 건으로 답을 기다리고 있고, 서연은 지금 하는 일 없어요.')
  const tool = companyStatusTool(paths)
  expect(tool.closes).toBe(true)
  expect(await tool.run({}, { task: '' })).toMatch(/^아직 지민, .*한테 맡긴 일이 없어요\.$/)
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
  // c11a: the record keeps the result's words, not its addresses.
  const now = '노션 신기능 조사 → 노션이 AI 회의록을 냈다 (지민, 2026-11-16)'
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
import { aboutEmployee, assignTool, employeeNote, employeeWriteBack, employeesReport, handedFrom, handoffBrief, mergedReport, plainHire, reportData, COMPANY_LANE_TOOLS, type AssignHost } from '../src/company-tools.js'
import { settleMember } from '../src/team-hire-tools.js'

// c11a: a teammate hands back a fenced report block; the host keeps it as TeamMember.data (team-runner: reportData, then settleMember).
const block = (report: Record<string, unknown>): string => `\`\`\`report\n${JSON.stringify(report)}\n\`\`\``
const reported = (m: TeamMember, report: Record<string, unknown>): TeamMember => {
  const one: TeamMember = { ...m }, answer = block(report)
  settleMember(one, { answer, ...(m.sources ? { sources: m.sources } : {}), report: reportData(answer, one, m.sources ?? [], true) ?? null }, '2026-11-17T03:00:00.000Z', true)
  return one
}
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// c11a: the structure every team answer keeps, whoever wrote it: each teammate named, never on a line that starts "이름:", each page given
// as a named link (never named 출처), and no raw address.
function expectParts(text: string | undefined, parts: readonly (readonly [name: string, ...urls: string[]])[]): void {
  expect(text).toBeDefined()
  for (const [name, ...urls] of parts) {
    expect(text).toContain(name)
    expect(text).not.toMatch(new RegExp(`^\\s*(?:[-*]\\s*)?${escaped(name)}\\s*[:：]`, 'm'))
    for (const url of urls) expect(text).toMatch(new RegExp(`\\[[^\\]\\n]+\\]\\(${escaped(url)}\\)`))
  }
  expect(text).not.toContain('[출처]')
  expect(text!.replace(/\]\([^)]*\)/g, ']')).not.toMatch(/https?:\/\//)
}

async function office(work: (member: TeamMember) => { answer: string; asked?: boolean; error?: string } = member => ({ answer: block(member.writer ? { items: [`${member.role} 결과`] } : { facts: [{ text: `${member.role} 결과`, url: `https://example.com/${member.id}` }] }) })) {
  const c = await company()
  await c.run({ add: [{ name: '지민', role: '리서치 담당', how: '자료를 찾아 출처와 함께 정리한다' }, { name: '서연', role: '카피 담당' }] })
  const task = { id: 't1', goal: '경쟁사 조사', botId: c.chief.id, state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [] } as DelegatedTask
  const later: string[][] = [], attached: unknown[] = []
  let attach = false
  // As team-runner settles a teammate: a lookup or a writer on the team hands back its report block (c11a), any other part its prose.
  const finish = (ids: string[]) => { for (const m of task.team!.members.filter(one => ids.includes(one.id))) { const done = work(m); settleMember(m, { ...done, ...(m.botId && (m.lookup || m.writer) ? { report: reportData(done.answer, m, [], true) ?? null } : {}) }, '2026-11-16T01:00:00.000Z') } }
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
  // c7: no table nobody asked for. c11a (structure): who was added comes first, then every teammate with their part, their finding and
  // their link named by its site, never a line that opens "이름:".
  expect(said.startsWith('도윤은 새로 넣었어요.')).toBe(true)
  expect(said).not.toMatch(/^\|/m)
  expectParts(said, [['지민', 'https://example.com/m1'], ['서연', 'https://example.com/m2'], ['도윤', 'https://example.com/m3']])
  for (const [topic, found] of [['노션', '지민 결과'], ['슬랙', '서연 결과'], ['리니어', '도윤 결과']]) { expect(said).toContain(topic); expect(said).toContain(found) }
  // Each is the employee (botId), a fast lookup, and already accepted: the lead needs no review round.
  expect(o.task.team!.members.map(m => [m.botId === (m.role === '도윤' ? lee.id : m.botId), m.lookup, m.state, m.review?.ok, m.background])).toEqual([[true, true, 'released', true, undefined], [true, true, 'released', true, undefined], [true, true, 'released', true, undefined]])
  expect(o.task.team!.members[0]!.botId).toBe((await o.named('지민'))!.id)
  expect(typeof o.tool.closes === 'function' && [o.tool.closes({ wait: true, to: [{ who: '지민', brief: 'a' }] }), o.tool.closes({ wait: true, to: [{ who: '지민', brief: 'a', make: true }] }), o.tool.closes({ wait: false })]).toEqual([true, false, true])
  // A part that makes something still comes back as reports for the lead to merge, with the pages each one read.
  const making = await office()
  const out = JSON.parse(await making.assign({ wait: true, to: [{ who: '지민', brief: '노션 신기능 표로 저장', make: true }, { who: '서연', brief: '슬랙 신기능' }] }))
  expect(out.reports.map((r: { who: string; state: string }) => [r.who, r.state])).toEqual([['지민', 'done'], ['서연', 'done']])
  expect(out.reports[1].result).toContain('https://example.com/m2')
  expect(out.note).toContain('A table only when the person asked')
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
  expect(o.task.team!.members[1]!.then).toEqual({ botId: (await o.named('서연'))!.id, who: '서연', brief: '홍보 문구 3개', voice: '밝고 시원시원하게' })
})

test('a failed part is said as failed, and an agent who needs the person is asked up', async () => {
  const failing = await office(member => member.role === '서연' ? { answer: '', error: 'no source' } : { answer: block({ facts: [{ text: `${member.role} 결과`, url: 'https://example.com/a' }] }) })
  const out = await failing.assign({ wait: true, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }] })
  // The missing part is said in its own row, never dropped and never the host's own failure note (c11a: structure).
  expectParts(out, [['지민', 'https://example.com/a'], ['서연']])
  expect(out).toContain('지민 결과')
  // c12a B1: the row is the part's name in the person's words (here the brief itself, "b", by topicOf) and the teammate, never a job title.
  expect(out.split('\n').at(-1)).toMatch(/^b\(서연\): 이번엔 못 찾았어요\.$/)
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
  // c9 fix 2: the opener says what it was made from, with that page; no closing source sentence.
  // c9b r2: said in 서연's own (bright) way.
  // c11a (structure): 서연's deliverable as a numbered list, said to be made from 지민's find, and that find's page linked.
  const handed = await o.assign(hand)
  // grokbar C6: writing from what was handed over is a writer's job (no web), not a lookup.
  expect(o.task.team!.members[0]).toMatchObject({ writer: true, title: '홍보 문구 3개' })
  // c12a B1: one item is that line on its own (as checkedReport allows the writer).
  expect(handed).toMatch(/^서연 결과$/m)
  expect(handed).toMatch(/지민이 찾은/)
  expect(o.task.team!.members[0]!.lookup).toBeUndefined()
  expect(o.task.team!.members[0]!.brief).toBe(handoffBrief('홍보 문구 3개', '지민', '11월 20일 서울 AI 서밋 https://example.com/summit', '행사'))
  expect(handedFrom(o.task.team!.members[0]!.brief)).toEqual({ brief: '홍보 문구 3개', from: '지민', job: '행사', result: '11월 20일 서울 AI 서밋 https://example.com/summit' })
  expect(handedFrom(handoffBrief('문구', '지민', '결과'))).toEqual({ brief: '문구', from: '지민', job: '', result: '결과' })
  expect(handedFrom('그냥 일')).toBeUndefined()
  expectParts(handed, [['서연'], ['지민', 'https://example.com/summit']])
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
  // c11a: the record line keeps the words and drops the address.
  const line = '노션 신기능 조사 → 노션이 AI 회의록을 추가했습니다. (지민, 2026-11-16)'
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

test('the merged report is one table: a row per agent, their link, a missing part said in its row (c11a: structure)', () => {
  const three = [
    reported(part('m1', '지민', '노션'), { facts: [{ text: 'Notion Agent 업그레이드 (11/12)', url: 'https://www.notion.com/releases' }, { text: '새 모델 라우터', url: 'https://www.notion.com/releases' }] }),
    // A fact given with no page takes the page that was read, never the search page they started from.
    reported(part('m2', '서연', '슬랙', { sources: ['https://slack.com/blog/news', 'https://slack.com/intl/ko-kr/whats-new', 'https://search.naver.com/search.naver?query=slack'] }), { facts: [{ text: 'Salesforce 스워밍 도입, 채널 자동 생성' }] }),
    part('m3', '도윤', '리니어', { state: 'failed', result: 'Failed: it ran out of time before it reported anything.' }),
  ], topics = new Map([['m1', '노션'], ['m2', '슬랙'], ['m3', '리니어']])
  // c7 (USER-NOTES): with no table asked for there is none. c11a: one block per part, its part and whose it is, each fact with its own
  // link, and the missing part said in its own block.
  const report = mergedReport(three, topics)
  expect(report).not.toMatch(/^\|/m)
  expect(report.split('\n\n')).toHaveLength(3)
  expectParts(report, [['지민', 'https://www.notion.com/releases'], ['서연', 'https://slack.com/blog/news'], ['도윤']])
  for (const said of ['노션', 'Notion Agent 업그레이드 (11/12)', '새 모델 라우터', '슬랙', 'Salesforce 스워밍 도입, 채널 자동 생성', '리니어']) expect(report).toContain(said)
  expect(report).not.toContain('search.naver.com')
  expect(report.split('\n\n')[2]).toMatch(/\(도윤\): 이번엔 못 찾았어요\.$/)
  expect(report).not.toContain('(여기까지')
  expect(report).not.toMatch(/Failed|ran out of time/)
  // Codex cap (b7 r3): the host's limit note for a result cut short was shown in the row as written.
  expect(report).not.toMatch(/한도|멈춤|stopped at/)
})

test('one agent\'s result stands as they wrote it, and a handoff keeps the facts it was made from (c11a: structure)', () => {
  const alone = mergedReport([reported(part('m1', '지민', '행사'), { facts: [{ text: '12월 2일 소프트웨이브', url: 'https://example.com/a' }] })])
  expectParts(alone, [['지민', 'https://example.com/a']])
  expect(alone).toContain('12월 2일 소프트웨이브')
  // Nothing written out as an address: the page they read is added as a link.
  const read = mergedReport([reported(part('m1', '지민', '행사', { sources: ['https://example.com/a'] }), { facts: [{ text: '12월 2일 소프트웨이브' }] })])
  expectParts(read, [['지민', 'https://example.com/a']])
  expect(read).toContain('12월 2일 소프트웨이브')
  // C6 as it ran: 지민 worked first, his result went on to 서연 (TeamMember.then), and the task holds both.
  const kim = reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개' } }), { facts: [{ text: '소프트웨이브 2026: 12월 2일~4일, 코엑스', url: 'https://example.com/sw' }] })
  const park = reported(part('m2', '서연', handoffBrief('홍보 문구 3개', '지민', kim.result!, kim.brief), { background: true, lookup: undefined, writer: true }), { items: ['12월, 코엑스에서 만나요', '참가비 무료', '지금 사전등록'] })
  const task = { id: 't', goal: 'g', botId: 'chief', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members: [kim, park], hires: 2, maxHires: 8, maxDepth: 3, big: false } } as DelegatedTask
  // c7 C6: 서연 speaks, the lines stay a numbered list. c9 fix 2: where the facts came from is said once, with its link.
  const handed = employeesReport(task)
  expect(handed!.split('\n').filter(line => /^\d+\. /.test(line))).toEqual(['1. 12월, 코엑스에서 만나요', '2. 참가비 무료', '3. 지금 사전등록'])
  expect(handed).toContain('지민이 찾은')
  // The first one found nothing at all, so nothing was handed on: their part is said plainly as not found (c4 H5).
  const unsettled: TeamMember = { ...kim, data: undefined }
  const none = employeesReport({ ...task, team: { ...task.team!, members: [{ ...unsettled, state: 'failed', result: 'Failed: it was stopped.' }] } })
  expectParts(none, [['지민']])
  expect(none).toContain('못 찾았어요')
  expect(none).not.toMatch(/Failed|stopped/)
  // Someone who needs the person, or a file handed in, is the lead's to report.
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'waiting' }] } })).toBeUndefined()
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, files: ['a.xlsx'] }] } })).toBeUndefined()
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, background: undefined }] } })).toBeUndefined()
  expect(employeesReport(undefined)).toBeUndefined()
  expectParts(handed, [['서연'], ['지민', 'https://example.com/sw']])
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

// c11a: the same run as each teammate hands it back now, as data: 지민 saw nothing this week (the newest was 10월 19일), 서연 gave no report
// (her prose is never parsed), 도윤 gave two dated facts with their pages; 지민 on C5 gave one event from the search page he read.
const unreported = (m: TeamMember): TeamMember => { const one: TeamMember = { ...m }; settleMember(one, { answer: m.result ?? '', ...(m.sources ? { sources: m.sources } : {}), report: null }, '2026-11-17T03:00:00.000Z', true); return one }
const c3d = [
  reported(c3[0]!, { facts: [], nothing_in_period: { latest: { text: 'Notion Agent 대폭 개선', url: c3[0]!.sources![0], date: '10월 19일' } } }),
  unreported(c3[1]!),
  reported(c3[2]!, { facts: [{ text: 'Coding agent에 BYOK 지원 추가', url: 'https://linear.app/changelog/2026-11-12-bring-your-own-key', date: '11월 12일' }, { text: '모바일에서 코드 변경 사항을 보는 기능 추가', url: 'https://linear.app/changelog/2026-11-04-mobile-diffs', date: '11월 4일' }] }),
]
const c5d = [reported(c5[0]!, { facts: [{ text: '국내 소프트웨어 기업 연말 행사, 무료 입장', url: c5[0]!.sources![0], date: '12월 2일~4일' }] })]

test('the host\'s own table on the results as they were stored: no notes on the looking, no English sentence, one link per site (c11a: structure)', () => {
  const report = mergedReport(c3d)
  // c7: nobody asked for a table, so there is none. c11a: one block per teammate, each named with their part.
  expect(report).not.toMatch(/^\|/m)
  const rows = report.split('\n\n')
  expect(rows).toHaveLength(3)
  // c12a B1: with no part names given, each part leads with its teammate's name, never the job's to-do label.
  expect(rows.map(row => /^(지민|서연|도윤)[이은가는]/.exec(row)?.[1])).toEqual(['지민', '서연', '도윤'])
  expect(report).not.toMatch(/신기능 조사\(/)
  expectParts(report, [['지민', c3[0]!.sources![0]!], ['서연', c3[1]!.sources![0]!], ['도윤', 'https://linear.app/changelog/2026-11-12-bring-your-own-key', 'https://linear.app/changelog/2026-11-04-mobile-diffs']])
  // A teammate who gave no report is said plainly, as unfinished with a named link to where they looked; their prose is never shown.
  expect(rows[1]).toBe(`서연은 이번엔 끝까지 못 봤어요. 보던 곳은 [Bing 검색](${c3[1]!.sources![0]!})`)
  expect(rows[2]).toContain('Coding agent에 BYOK 지원 추가')
  // U3, U6, U1 as they were measured.
  expect(report).not.toMatch(/턴|실패|\(여기까지|확인 불가|누락|시도|한도|결과예요|보고/)
  expect(report).not.toMatch(/This week|Bring Your Own Key|entries found/)
  expect(report).not.toMatch(/Agents, rebuilt|(?:[A-Za-z][A-Za-z'’-]*[\s,]+){3}[A-Za-z]/)
  // c6: asked for this week on 2026-11-17, nothing new is said as that, and the newest find keeps its date and its link.
  expect(rows[0]).toMatch(/새로 나온 게 없어요/)
  expect(rows[0]).toContain('10월 19일')
  expect(rows[0]).toContain('Notion Agent 대폭 개선')
  for (const row of rows) for (const line of row.split('\n')) { const hosts = [...line.matchAll(/\]\(https?:\/\/([^/)]+)/g)].map(hit => hit[1]); expect(new Set(hosts).size, line).toBe(hosts.length) }
  // c4 C5: nothing is said about a result that was cut short.
  expect(report).not.toMatch(/여기까지|더 있을 수/)
  // C5, one person: who brought it, what they found, the link once, and no "출처" label.
  const one = mergedReport(c5d)
  expectParts(one, [['지민', c5[0]!.sources![0]!]])
  expect(one.split('\n').some(line => /^\s*(?:\[[^\]]+\]\([^)]+\)[\s·]*)+$/.test(line))).toBe(false)
  expect(one).toContain('12월 2일~4일')
  expect(one).not.toMatch(/출처|시간 초과|확인하지 못|\(여기까지|결과예요|습니다\.\n\n\(/)
  expect(one.match(/\]\(https:\/\/search\.naver\.com/g)).toHaveLength(1)
})

test('the writer pass: fixed input, the host checks what comes back, and the host\'s table stands in when it fails (c11a: structure)', async () => {
  const topics = new Map([['m1', '노션'], ['m2', '슬랙'], ['m3', '리니어']])
  const prompt = reportPrompt(stored.c3.goal, c3d, topics)
  // The input: the ask, and per teammate the name, the part and the data with its links; never the host's own limit note.
  expect(prompt).toContain('"name":"지민","part":"노션"')
  expect(prompt).toContain('https://linear.app/changelog/2026-11-12-bring-your-own-key')
  expect(prompt).toContain('나눠서 시켜')
  // c4 C5: the writer is never told a result was cut short, so it cannot say "더 있을 수 있어요".
  expect(prompt).not.toContain('"cut"')
  expect(prompt).not.toMatch(/한도에서 멈춤/)
  // c11a: a teammate with no report is never given with their prose. c12a A2: nor at all: the host says that part after the message.
  expect(prompt).not.toContain('"name":"서연"')
  expect(prompt).toContain('Do not mention 서연 at all')
  expect(prompt).not.toMatch(/확인 불가|이번 턴/)
  // c7: each teammate named in sentences, never a line that opens on a name and a colon; a table only for a comparison.
  expect(prompt).toContain('a line never starts with a name and a colon')
  expect(prompt).toContain('A markdown table only when')
  const bing = c3[0]!.sources![0]!, byok = 'https://linear.app/changelog/2026-11-12-bring-your-own-key'
  const full = ['노션은 큰 개선이 있었고, 리니어는 자체 키 연결을 넣었어요.', '',
    `노션은 지민이 봤는데 이번 주엔 새 소식이 없고, 10월 19일에 Notion Agent가 크게 개선된 게 제일 최근이에요. [출처](${bing})`, '',
    '슬랙은 서연이 이번엔 못 찾았어요.', '',
    `리니어는 도윤이 봤는데 11월 12일에 BYOK 지원이 추가됐어요. [출처](${byok}) [다른 곳](https://evil.example/x)`].join('\n')
  const said = (text: string, kept = ['f1']): string => JSON.stringify({ message: text, kept })
  const message = full.replace(/\n\n슬랙은 .*$/m, '')
  // c12a A2: the writer says nothing of 서연 (no data); the host's own line for that part follows the message, with where they looked.
  const good = said(message)
  const asked: string[] = []
  const out = await writtenReport({ ask: stored.c3.goal, members: c3d, topics, write: async text => { asked.push(text); return good } })
  expect(asked).toEqual([prompt])
  // Links it was given are kept, named by the host from the data; an address it was not given is dropped, its words stay.
  expectParts(out, [['지민', bing], ['서연'], ['도윤', byok]])
  expect(out).not.toContain('evil.example')
  expect(out).toContain('다른 곳')
  expect(out).not.toContain('서연이 이번엔 못 찾았어요.')
  expect(out.split('\n\n').at(-1)).toBe(`슬랙(서연): 이번엔 끝까지 못 봤어요. 보던 곳은 [Bing 검색](${c3[1]!.sources![0]!})`)
  expect(out).not.toMatch(/^\|/m)
  const fallback = mergedReport(c3d, topics)
  // A teammate not named, a line that opens on a name, a nothing-new part without its latest link, a kept fact unlinked or a linked one
  // not kept, a raw address, an English sentence, a word the person must not read, no JSON, nothing: the host's rendering.
  // c12a A2: so is a message that says the part with no data (found or empty).
  for (const bad of [said(full), said(message.replace(/\n\n리니어는 .*$/m, '')), said(message.replace('노션은 지민이', '지민: 노션은')), said(message.replace(/ \[출처\]\(https:\/\/www\.bing[^)]*\)/, '')),
    said(message.replace(/ \[출처\]\(https:\/\/linear[^)]*\)/, '')), said(message, ['f1', 'f2']), said(message.replace('[다른 곳](https://evil.example/x)', 'https://evil.example/x')),
    said(message.replace('크게 개선된 게', 'This week the agent was rebuilt, 그게')), said(message.replace('자체 키 연결을', '세션 키 연결을')), message, said(''), ''])
    expect(await writtenReport({ ask: stored.c3.goal, members: c3d, topics, write: async () => bad }), bad.slice(0, 60)).toBe(fallback)
  expect(await writtenReport({ ask: stored.c3.goal, members: c3d, topics, write: async () => { throw new Error('no model') } })).toBe(fallback)
  expect(await writtenReport({ ask: stored.c3.goal, members: c3d, topics, timeoutMs: 20, write: () => new Promise(resolve => setTimeout(() => resolve(good), 200)) })).toBe(fallback)
  expect(await writtenReport({ ask: stored.c3.goal, members: c3d, topics })).toBe(fallback)
  // What the call said first stays in front of the writer's text.
  expect(await writtenReport({ ask: stored.c3.goal, members: c3d, topics, hired: ['도윤은 새로 넣었어요.'], write: async () => good })).toMatch(/^도윤은 새로 넣었어요\. 노션은/)
  // Nobody brought data back: the model is not asked, and the part is said plainly.
  const none = vi.fn(async () => good)
  const plain = await writtenReport({ ask: 'x', members: [c3d[1]!], write: none })
  expectParts(plain, [['서연', c3[1]!.sources![0]!]])
  expect(plain).toMatch(/이번엔 끝까지 못 봤어요\. 보던 곳은 \[Bing 검색\]\([^)]+\)$/)
  expect(none).not.toHaveBeenCalled()
  expect(checkedReport(good, c3d)).toBeDefined()
  // c7: a table only when things are compared; the host's own rendering has none.
  const cities = [reported(part('m1', '지민', '서울 날씨 조사', { topic: '서울' }), { facts: [{ text: '맑음, 18도', url: 'https://a.example/seoul' }] }), reported(part('m2', '서연', '부산 날씨 조사', { topic: '부산' }), { facts: [{ text: '흐림, 20도', url: 'https://b.example/busan' }] })]
  expect(mergedReport(cities)).not.toMatch(/^\|/m)
  expectParts(mergedReport(cities), [['지민', 'https://a.example/seoul'], ['서연', 'https://b.example/busan']])
  // c7 C5: an item's link stays on it, named by the site (a search page is named as one, never 출처).
  const naver = c5[0]!.sources![0]!
  expect(checkedReport('지민이 정리해 왔어요.\n\n- 12월 2~4일 연말 행사', c5d)).toBeUndefined()
  const listed = checkedReport(said(`지민이 정리해 왔어요.\n\n- 12월 2~4일 연말 행사 [링크](${naver})`), c5d)
  expectParts(listed, [['지민', naver]])
})

test('a hand-off result is written in the hand-off shape, and the background report goes through the same writer (c11a: structure)', async () => {
  const notion = 'https://www.notion.com/releases/2026-10-19'
  const kim = reported(part('m1', '지민', '노션 신기능 조사', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개 뽑기' } }), { facts: [{ text: 'Notion Agent가 크게 개선됐어요.', url: notion }] })
  const items = ['일은 동료에게 맡기세요', '하루를 맡기세요', '더 적은 비용으로']
  const park = reported(part('m2', '서연', handoffBrief('홍보 문구 3개 뽑기', '지민', kim.result!, kim.brief), { background: true, lookup: undefined, writer: true }), { items })
  const task = { id: 't', goal: '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', botId: 'chief', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members: [kim, park], hires: 2, maxHires: 8, maxDepth: 3, big: false } } as DelegatedTask
  // The handed-on brief carries the giver's fact with its page.
  expect(handedFrom(park.brief)?.result).toContain(notion)
  const prompt = reportPrompt(task.goal, task.team!.members)
  // c11a: the deliverable's items, each copied exactly as a numbered list, and whose find it was made from.
  expect(prompt).toContain('each copied exactly')
  expect(prompt).toContain('"madeFrom":"지민"')
  expect(prompt).toContain(JSON.stringify(items))
  // c9 fix 2: no closing source sentence.
  expect(prompt).toContain('no closing recap')
  expect(prompt).not.toContain('찾은 내용:')
  const said = (message: string): string => JSON.stringify({ message, kept: [] })
  const written = `서연이 지민이 찾은 노션 소식으로 문구 세 개를 뽑아 봤어요.\n\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`
  const answer = await employeesAnswer(task, async () => said(written))
  expect(answer!.split('\n').filter(line => /^\d+\. /.test(line))).toEqual(items.map((item, i) => `${i + 1}. ${item}`))
  expectParts(answer, [['서연'], ['지민']])
  // No model, or a text that fails the check (an item changed, a line that opens on a name, no JSON): the host's own lines, with both
  // names and the three lines.
  const own = await employeesAnswer(task)
  expect(own).toBe(employeesReport(task))
  expect(own!.split('\n').filter(line => /^\d+\. /.test(line))).toEqual(items.map((item, i) => `${i + 1}. ${item}`))
  expect(own).toContain('서연')
  expect(own).toContain('지민이 찾은')
  for (const bad of [said(written.replace('하루를', '이틀을')), said(written.replace('서연이 지민이', '서연: 지민이')), '서연 결과예요.'])
    expect(await employeesAnswer(task, async () => bad)).toBe(own)
  expect(await employeesAnswer({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'waiting' }] } }, async () => said(written))).toBeUndefined()
  // c9 fix 2: the find the copy was made from is linked, on its page.
  expect(prompt).toContain(notion)
  expectParts(own, [['서연'], ['지민', notion]])
})

// grokbar c3b r2: 지민 read a page but his memo named no address; the hand-off dropped it and the answer went out uncited.
test('a hand-off carries the pages the first teammate read when the memo names none (c11a: structure)', async () => {
  const page = 'https://weather.example/seoul'
  // c11a: a fact given with no page is tied to the page that was read (reportData), so the hand-off carries it.
  const kim = reported(part('m1', '지민', '서울 날씨 조사', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '나들이 문구 쓰기' }, sources: [page] }), { facts: [{ text: '토요일 서울은 맑고 20도예요.' }] })
  const carried = handoffBrief('나들이 문구 쓰기', '지민', kim.result!, kim.brief)
  expect(handedFrom(carried)?.result).toContain(page)
  const members = [kim, reported(part('m2', '서연', carried, { background: true, lookup: undefined, writer: true }), { items: ['맑은 토요일, 가볍게 나들이 가요.'] })]
  const own = mergedReport(members)
  expect(own).toContain('맑은 토요일, 가볍게 나들이 가요.')
  expect(own).toContain('지민이 찾은')
  const uncited = JSON.stringify({ message: '서연이 지민이 찾은 서울 날씨로 나들이 문구를 써 봤어요.\n\n1. 맑은 토요일, 가볍게 나들이 가요.', kept: [] })
  // The page that was read is in the writer's data and in the host's own answer; an answer that leaves it out is refused.
  expect(reportPrompt('날씨 보고 문구 써줘', members)).toContain(page)
  expectParts(own, [['서연'], ['지민', page]])
  expect(checkedReport(uncited, members)).toBeUndefined()
  expect(await writtenReport({ ask: '날씨 보고 문구 써줘', members, write: async () => uncited })).toBe(own)
})

// c3b review r3 (Codex): a memo that named only a search-results address counted as cited, so the page the teammate read was dropped
// from the hand-off, the host's answer and the writer's prompt, and an answer citing only the search was let through.
test('a hand-off whose memo names only a search-results address still carries the page that was read (c11a: structure)', async () => {
  const search = 'https://search.naver.com/search.naver?query=seoul', page = 'https://weather.example/seoul'
  const kim = reported(part('m1', '지민', '서울 날씨 조사', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '문구 쓰기' }, sources: [search, page] }), { facts: [{ text: '서울은 맑아요.' }] })
  const carried = handoffBrief('문구 쓰기', '지민', kim.result!, kim.brief)
  expect(handedFrom(carried)?.result).toContain(page)
  expect(carried).not.toContain('search.naver.com')
  const members = [kim, reported(part('m2', '서연', carried, { background: true, lookup: undefined, writer: true }), { items: ['맑은 서울로 떠나요.'] })]
  expect(mergedReport(members)).not.toContain('search.naver.com')
  const text = '서연이 지민이 찾은 서울 날씨로 이렇게 써 봤어요.\n\n1. 맑은 서울로 떠나요.'
  // Nothing read but the search: the search address still stands in, as before.
  expect(mergedReport([reported(part('m1', '지민', '서울 날씨 조사', { background: true, sources: [search] }), { facts: [{ text: '서울은 맑아요.' }] })])).toContain('search.naver.com')
  // The page that was read is in the writer's data and the host's answer; an answer citing only the search is refused.
  expect(reportPrompt('문구 써줘', members)).toContain(page)
  expectParts(mergedReport(members), [['서연'], ['지민', page]])
  expect(checkedReport(JSON.stringify({ message: `${text}\n\n지민이 찾아보니 서울은 맑아요. [네이버 검색](${search})`, kept: [] }), members)).toBeUndefined()
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
  const found = { facts: [{ text: '새 기능', url: 'https://example.com/new' }] }
  const later = mergedReport([reported(o.task.team!.members.at(-1)!, found), reported(o.task.team!.members[0]!, found)])
  // c11a (structure): the row is named by the part's own name and whose it is.
  expect(later.split('\n\n')[0]).toMatch(/^리니어\(도윤\): 새 기능 \[[^\]]+\]\(https:\/\/example\.com\/new\)$/)
  expectParts(later, [['도윤', 'https://example.com/new'], ['지민']])
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
  expect(companyStatus(bots, tasks)).toBe('지우는 다음 달 서울 IT 행사 일정 정리, 서연은 슬랙의 이번 주 신기능 조사, 도윤은 리니어의 이번 주 신기능 조사를 끝낸 게 마지막이에요. 지금은 다들 한가해요.')
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
  // c11a: a teammate that saw nothing new hands that back as data (empty), and team-runner records no result for it.
  const empty = reported(c3[1]!, { facts: [], nothing_in_period: {} })
  expect(empty.empty).toBe(true)
  await employeeWriteBack(o.paths, { botId: kim.id, brief: empty.brief, result: empty.empty ? '' : empty.result! }, at)
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
import { topicOf, askedCount, dutyList, dutyToCancel, isDutyListAsk, plainChange, plainSplit } from '../src/company-tools.js'
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

test('c4 C3/H5: a teammate whose time ran out with results in hand has their part written from what they read; a stop keeps nothing (c11a: structure)', async () => {
  const read = '노션 3.0 출시: AI 회의록이 추가됐어요, 2026.11.12. https://www.notion.com/releases/3-0\n슬랙 허들 요약 공개: 2026.11.10. https://slack.com/blog/huddles'
  // A helper with no report to give (no teammate) still keeps what it read when its time ran out.
  const cutShort = part('m1', '지민', '노션 신기능 조사', { state: 'working', topic: '노션' })
  settleMember(cutShort, { answer: '', timedOut: true, read, sources: ['https://search.naver.com/search.naver?query=notion'] }, 'now', true)
  expect(cutShort).toMatchObject({ state: 'done', read: true })
  // c11a: a teammate hands back its finding as data, whenever its time ran out.
  const kim = reported(part('m1', '지민', '노션 신기능 조사', { topic: '노션', sources: ['https://search.naver.com/search.naver?query=notion'] }), { facts: [{ text: '노션 3.0 출시: AI 회의록이 추가됐어요', url: 'https://www.notion.com/releases/3-0', date: '11월 12일' }] })
  const done = reported(part('m2', '서연', '슬랙 신기능 조사', { topic: '슬랙' }), { facts: [{ text: '슬랙이 허들 요약을 냈어요.', url: 'https://slack.com/blog/huddles' }] })
  // The host's own lines: his has what he found and its link, never "못 찾았어요", and no word about the cut.
  const table = mergedReport([kim, done])
  const row = table.split('\n\n').find(block => block.includes('(지민)'))!
  expect(row).toContain('노션 3.0 출시')
  expectParts(row, [['지민', 'https://www.notion.com/releases/3-0']])
  expect(table).not.toMatch(/못 찾았어요|한도|멈춤|여기까지|더 있을 수/)
  // The writer is given the same material, and its links pass the host's check, named from the data.
  const prompt = reportPrompt('노션, 슬랙 신기능 조사해서 알려줘', [kim, done])
  expect(prompt).toContain('https://www.notion.com/releases/3-0')
  expect(prompt).not.toMatch(/"cut"|한도에서 멈춤/)
  const message = '둘 다 찾아왔어요.\n\n노션은 지민이 봤는데 AI 회의록이 추가됐어요. [Notion 릴리스](https://www.notion.com/releases/3-0)\n\n슬랙은 서연이 봤는데 허들 요약이 나왔어요. [슬랙](https://slack.com/blog/huddles)'
  const said = (text: string): string => JSON.stringify({ message: text, kept: ['f1', 'f2'] })
  const checked = checkedReport(said(message), [kim, done])
  expectParts(checked, [['지민', 'https://www.notion.com/releases/3-0'], ['서연', 'https://slack.com/blog/huddles']])
  expect(checked).not.toContain('[Notion 릴리스]')
  // c7: every teammate is named in the one message.
  expect(checkedReport(said(message.replace('지민이 봤는데 ', '')), [kim, done])).toBeUndefined()
  // A hand-off goes on from it (H5): the second teammate gets what was found, and the one bubble names both.
  const first = reported(part('m1', '지민', '이번 주말 서울 날씨 찾기', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '주말 나들이 추천 문구 한 줄 쓰기' } }), { facts: [{ text: '토요일 서울 맑음, 최고 12도', url: 'https://weather.example/seoul', date: '11월 21일' }] })
  expect(first.state).toBe('done')
  const brief = handoffBrief(first.then!.brief, '지민', first.result!, first.brief)
  expect(handedFrom(brief)?.result).toContain('https://weather.example/seoul')
  const second = reported(part('m2', '서연', brief, { background: true, lookup: undefined, writer: true }), { items: ['맑은 토요일, 가볍게 한강 나들이 어때요?'] })
  const handed = mergedReport([first, second])
  expect(handed).toContain('맑은 토요일, 가볍게 한강 나들이 어때요?')
  expect(handed).toContain('지민이 찾은')
  // Nothing read at all: one plain line that says what is missing.
  const unsettled: TeamMember = { ...first, data: undefined }
  const empty = { ...unsettled, state: 'failed' as const, result: 'Failed: it ran out of time before it reported anything.' }
  expectParts(mergedReport([empty]), [['지민']])
  expect(mergedReport([empty])).toMatch(/못 찾았어요\.$/)
  // "멈춰": stopped, and nothing of what was read is kept (rule 4).
  const stopped = part('m3', '도윤', '리니어 조사', { state: 'working' })
  settleMember(stopped, { answer: '', error: 'it was stopped.', read }, 'now', true)
  expect(stopped).toMatchObject({ state: 'failed', result: 'Failed: it was stopped.' })
  expect(stopped.read).toBeUndefined()
  expect(JSON.stringify(stopped)).not.toContain('노션 3.0')
  // c9 fix 2: the hand-off's bubble links the find it was made from.
  expectParts(handed, [['서연'], ['지민', 'https://weather.example/seoul']])
})

test('c4 C6: N short things asked for come back as a numbered list of N, from the host and from the writer (c11a: structure)', () => {
  for (const [brief, n] of [['홍보 문구 3개 뽑기', 3], ['장점 3가지 정리', 3], ['소개 글 세 줄 쓰기', 3], ['후보 두 개 고르기', 2], ['문구 한 줄 쓰기', 0], ['12월 행사 일정 정리', 0], ['노션 신기능 조사', 0]] as const) expect(askedCount(brief), brief).toBe(n)
  const kim = reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개 뽑기' } }), { facts: [{ text: '소프트웨이브 2026', url: 'https://example.com/sw', date: '12월 2일~4일' }] })
  const lines = ['"12월 2일, 서울에서 만나요"', '"비즈니스 데이부터 참관객의 날까지"', '"올해 서울 IT 행사의 하이라이트"']
  // A writer that gave one more than asked keeps the number asked.
  const park = reported(part('m2', '서연', handoffBrief('홍보 문구 3개 뽑기', '지민', kim.result!, kim.brief), { background: true, lookup: undefined, writer: true }), { items: [...lines, '"하나 더"'] })
  expect(park.data!.items).toEqual(lines)
  const own = mergedReport([kim, park]), numbered = lines.map((line, i) => `${i + 1}. ${line}`)
  expect(own.split('\n').filter(line => /^\d\. /.test(line))).toEqual(numbered)
  expect(own).toContain('서연')
  expect(own).toContain('지민이 찾은')
  // c9 fix 2: nothing closes the list.
  expect(own.split('\n').slice(-3)).toEqual(numbered)
  // The writer is handed the items as they are, and three bare paragraphs back from it are refused (the host's list stands in).
  expect(reportPrompt('문구 뽑아줘', [kim, park])).toContain(JSON.stringify(lines))
  const said = (text: string): string => JSON.stringify({ message: text, kept: [] })
  expect(checkedReport(said(['서연이 지민이 찾은 행사로 뽑았어요.', ...lines].join('\n\n')), [kim, park])).toBeUndefined()
  // A numbered answer passes when it links the find it was made from; without that link it is refused.
  expect(checkedReport(said(['서연이 지민이 찾은 행사로 뽑았어요.', numbered.join('\n')].join('\n\n')), [kim, park])).toBeUndefined()
  const passed = checkedReport(said(['서연이 지민이 찾은 행사로 뽑았어요. [example.com](https://example.com/sw)', numbered.join('\n')].join('\n\n')), [kim, park])
  expect(passed?.split('\n').filter(line => /^\d\. /.test(line))).toEqual(numbered)
  // c9 fix 2: the opener links the find the list was made from.
  expect(own.split('\n\n')[0]).toMatch(/\[[^\]]+\]\(https:\/\/example\.com\/sw\)/)
})

test('c4 C7: "내 일정 뭐 있어?" is answered from the stored schedules, and "그거 취소해" right after means that one', () => {
  const kept = (id: string, goal: string, days: number[], hour: number): BotTask => ({ id, name: goal, goal, schedule: { days, hour, minute: 0 } } as BotTask)
  const weekly = kept('a', '지난주 팀이 한 일 요약해줘', [1], 9)
  for (const ask of ['내 일정 뭐 있어?', '일정 뭐 있어', '내 스케줄 알려줘']) expect(isDutyListAsk(ask), ask).toBe(true)
  for (const ask of ['내일 일정 정리해줘', '매주 월요일 9시에 요약해줘', '일정표 만들어줘']) expect(isDutyListAsk(ask), ask).toBe(false)
  // c9 fix 5: whose schedule it is is said (Engram's, not the person's calendar).
  expect(dutyList([])).toBe('제가 따로 챙기는 일정은 아직 없어요. 다른 약속은 제가 볼 수 있는 캘린더가 없어서 모르겠어요.')
  expect(dutyList([weekly, { id: 'r', name: 'x', goal: 'x', routineId: 'r1', schedule: { days: [1], hour: 8, minute: 0 } } as BotTask, { id: 'n', name: 'y', goal: 'y' } as BotTask])).toBe('제가 챙기는 건 매주 월요일 9시에 지난주 팀이 한 일 요약해 드리는 거 하나예요. 다른 약속은 제가 볼 수 있는 캘린더가 없어서 모르겠어요.')
  expect(dutyList([weekly, kept('b', 'AI 뉴스 정리해줘', [0, 1, 2, 3, 4, 5, 6], 18)])).toBe('제가 챙기는 정기 일정은 2개예요.\n\n- 매주 월요일 9시: 지난주 팀이 한 일 요약\n- 매일 오후 6시: AI 뉴스 정리\n\n다른 약속은 제가 볼 수 있는 캘린더가 없어서 모르겠어요.')
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

test('c4b r2: a teammate cut short with only English search rows shows no English run in the host table; the link stays and the writer is still asked (c11a: structure)', async () => {
  // c11a: the teammate's facts are in the person's language (REPORT_RULE), whatever language the page was in.
  const kim = reported(part('m1', '지민', '노션 신기능 조사', { topic: '노션', sources: ['https://search.example/?q=notion'] }), { facts: [{ text: '에이전트가 더 적은 비용으로 더 많이 하도록 다시 만들어졌고, 워크스페이스 관리 기능이 새로 나왔어요.', url: 'https://www.notion.com/releases' }] })
  const park = reported(part('m2', '서연', '슬랙 신기능 조사', { topic: '슬랙' }), { facts: [{ text: '슬랙이 캔버스 공유를 냈어요.', url: 'https://slack.com/blog' }] })
  const alone = mergedReport([kim])
  expectParts(alone, [['지민', 'https://www.notion.com/releases']])
  const table = mergedReport([kim, park])
  expectParts(table, [['지민', 'https://www.notion.com/releases'], ['서연', 'https://slack.com/blog']])
  for (const text of [alone, table]) expect(text.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(/(?:[A-Za-z][A-Za-z'’-]*[\s,:]+){3,}[A-Za-z]/)
  // The quick model is asked, and its links are named from the data.
  const write = vi.fn(async () => JSON.stringify({ message: '노션은 지민이 봤는데 더 적은 비용으로 더 많이 하도록 다시 만들어졌어요. [Notion](https://www.notion.com/releases)', kept: ['f1'] }))
  const written = await writtenReport({ ask: '노션 신기능 조사해줘', members: [kim], write })
  expect(written).toContain('더 적은 비용으로')
  expectParts(written, [['지민', 'https://www.notion.com/releases']])
  expect(write).toHaveBeenCalledOnce()
  // An English ask keeps its English result.
  expect(mergedReport([reported(part('m1', 'Kim', 'Look up Notion news'), { facts: [{ text: 'Agents rebuilt to do more for less', url: 'https://www.notion.com/releases' }] })])).toContain('Agents rebuilt to do more for less')
})

test('c4b r2: a written answer that drops a dated item the teammate listed is refused, and the host lists them all (c11a: structure)', async () => {
  const kim = reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리'), { facts: [{ text: '소프트웨이브', url: 'https://example.com/a', date: '12월 2일' }, { text: '개발자 행사', url: 'https://example.com/b', date: '12월 5일' }, { text: 'AI 행사', url: 'https://example.com/c', date: '12월 9일' }] })
  const said = (message: string, kept: string[]): string => JSON.stringify({ message, kept })
  // c11a: the writer says which facts it used; one it says it used but left unlinked, or one it linked but did not say, is refused.
  const one = said('지민이 정리했어요.\n\n- 12월 2일 소프트웨이브 [출처](https://example.com/a)', ['f1', 'f2', 'f3'])
  expect(checkedReport(one, [kim])).toBeUndefined()
  expect(checkedReport(said('지민이 정리했어요.\n\n- 12월 2일 소프트웨이브 [출처](https://example.com/a)\n- 12월 5일 개발자 행사 [출처](https://example.com/b)', ['f1']), [kim])).toBeUndefined()
  const all = '지민이 정리했어요.\n\n- 12/2 소프트웨이브 [출처](https://example.com/a)\n- 12월 5일 개발자 행사 [출처](https://example.com/b)\n- 2026-12-09 AI 행사 [출처](https://example.com/c)'
  expectParts(checkedReport(said(all, ['f1', 'f2', 'f3']), [kim]), [['지민', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c']])
  const shown = await writtenReport({ ask: kim.brief, members: [kim], write: async () => one })
  for (const day of ['12월 2일', '12월 5일', '12월 9일']) expect(shown).toContain(day)
  expectParts(shown, [['지민', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c']])
  // One fact, used and linked, passes.
  expect(checkedReport(said('지민이 정리했어요. 소프트웨이브가 열려요. [출처](https://example.com/a)', ['f1']), [reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리'), { facts: [{ text: '소프트웨이브', url: 'https://example.com/a', date: '12월 2일' }] })])).toBeDefined()
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
  for (const [i, m] of t.team!.members.entries()) if (m.state !== 'released') t.team!.members[i] = reported(m, { facts: [{ text: `${m.topic} 새 기능이 나왔어요`, url: `https://example.com/${m.id}` }] })
  // c11a (structure): one block per part still on it, each opening on the part and whose it is, the swapped one gone.
  const report = employeesReport(t)!
  expect(report.split('\n\n').map(block => /^(\S+\(\S+\))/.exec(block)?.[1])).toEqual(['노션(지민)', '리니어(도윤)', '지라(서연)'])
  expectParts(report, [['지민', 'https://example.com/m1'], ['도윤', 'https://example.com/m3'], ['서연', 'https://example.com/m4']])
  // A split that ended before the change could be made is left alone.
  const ended = split(['done', 'done', 'done'])
  expect(steerSplit(ended, { taskId: 't1', said: '', add: { role: '지민', botId: 'bot-m1', brief: brief('지라'), topic: '지라' } })).toBeUndefined()
  expect(ended.team!.members).toHaveLength(3)
})

test('c4b r3: three events on one day are three items: the writer keeping one of them is refused, and the host lists all three (c11a: structure)', async () => {
  const kim = reported(part('m1', '지민', '서울 IT 행사 일정 정리'), { facts: ['A', 'B', 'C'].map(x => ({ text: `행사 ${x}`, url: `https://example.com/${x.toLowerCase()}`, date: '12월 2일' })) })
  expect(kim.data!.facts).toHaveLength(3)
  const said = (message: string, kept: string[]): string => JSON.stringify({ message, kept })
  expect(checkedReport(said('지민이 정리했어요.\n\n- 12월 2일 행사 A [출처](https://example.com/a)', ['f1', 'f2', 'f3']), [kim])).toBeUndefined()
  expect(checkedReport(said('지민이 정리했어요.\n\n- 12월 2일 행사 A [출처](https://example.com/a)\n- 12월 2일 행사 B [출처](https://example.com/b)\n- 12월 2일 행사 C [출처](https://example.com/c)', ['f1', 'f2', 'f3']), [kim])).toContain('행사 C')
  const shown = await writtenReport({ ask: '서울 IT 행사 일정 정리해줘', members: [kim], write: async () => said('지민이 정리했어요.\n\n- 12월 2일 행사 A [출처](https://example.com/a)', ['f1', 'f2', 'f3']) })
  for (const event of ['행사 A', '행사 B', '행사 C']) expect(shown).toContain(event)
  expectParts(shown, [['지민', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c']])
})

// stack-4, from the c4b targeted run (runs/c4b-381043c9/C5.txt, C6.txt).
test('stack-4: a written answer with raw addresses or a line that is only the name is not shown, and no dash is left where an address was (c11a: structure)', async () => {
  const kim = reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { sources: ['https://search.naver.com/search.naver?query=x'] }), { facts: [{ text: '소프트웨이브 2026, 서울 코엑스 Hall A', url: 'https://www.coex.co.kr/a', date: '12월 2일(수)~12월 4일(금)' }, { text: 'ACC 2026', url: 'https://itsight.zdnet.co.kr/acc2026/main.html', date: '12월' }] })
  const said = (message: string): string => JSON.stringify({ message, kept: ['f1', 'f2'] })
  const raw = '지민이 다음 달 서울 IT 행사 일정을 찾아봤어요.\n\n지민:\n- 소프트웨이브 2026: 12월 2일(수)~12월 4일(금) — https://www.coex.co.kr/a\n- ACC 2026: 12월 개최 — https://itsight.zdnet.co.kr/acc2026/main.html'
  expect(checkedReport(said(raw), [kim])).toBeUndefined()
  expect(checkedReport(said(raw.replace('지민:\n', '')), [kim])).toBeUndefined()
  const linked = checkedReport(said('지민이 정리해 왔어요.\n\n- 소프트웨이브 2026: 12월 2일(수)~12월 4일(금) [코엑스](https://www.coex.co.kr/a)\n- ACC 2026: 12월 개최 [ACC](https://itsight.zdnet.co.kr/acc2026/main.html)'), [kim])
  expectParts(linked, [['지민', 'https://www.coex.co.kr/a', 'https://itsight.zdnet.co.kr/acc2026/main.html']])
  const shown = await writtenReport({ ask: '다음 달 서울 IT 행사 일정 정리', members: [kim], write: async () => said(raw) })
  expect(shown).toContain('서울 코엑스 Hall A')
  expectParts(shown, [['지민', 'https://www.coex.co.kr/a']])
  expect(shown).not.toMatch(/—\s*($|\n|·)|\*\*지민|(?<!\]\()https?:\/\//m)
})

// c4b review r3 #1 (stack-4): the count left out a teammate cut short, whose result is what it read.
test('stack-4: a teammate cut short on a schedule job still has every dated item counted; a lookup that read a ten-day box does not (c11a: structure)', async () => {
  const said = (message: string, kept: string[]): string => JSON.stringify({ message, kept })
  const one = said('지민이 정리했어요.\n\n- 12월 2일 행사 A [출처](https://example.com/a)', ['f1', 'f2', 'f3'])
  const kim = reported(part('m1', '지민', '서울 IT 행사 일정 정리'), { facts: ['A', 'B', 'C'].map(x => ({ text: `행사 ${x}`, url: `https://example.com/${x.toLowerCase()}`, date: '12월 2일' })) })
  expect(checkedReport(one, [kim])).toBeUndefined()
  const shown = await writtenReport({ ask: '서울 IT 행사 일정 정리', members: [kim], write: async () => one })
  for (const event of ['행사 A', '행사 B', '행사 C']) expect(shown).toContain(event)
  // Not a schedule or a list: the days of a forecast box nobody asked for are not required of the answer.
  const box = reported(part('m2', '지민', '이번 주말 서울 날씨 찾기'), { facts: [{ text: '11월 21일 맑음 8도, 22일 흐림 6도, 23일 비 5도', url: 'https://example.com/w' }] })
  expect(checkedReport(said('지민이 찾아 왔어요.\n\n주말인 11월 21일은 맑고 8도예요. [출처](https://example.com/w)', ['f1']), [box])).toContain('맑고 8도')
})

test('c4b r3: a schedule cut short after its first event is still written with the events and addresses the teammate had read (c11a: structure)', () => {
  // c11a: the teammate's report block holds every event it had, each with its page, whenever its time ran out.
  const kim = part('m1', '지민', '서울 IT 행사 일정 정리', { state: 'working', lookup: true })
  const answer = block({ facts: [{ text: '소프트웨이브', url: 'https://example.com/a', date: '12월 2일' }, { text: '개발자 행사', url: 'https://example.com/b', date: '12월 5일' }, { text: 'AI 행사', url: 'https://example.com/c', date: '12월 9일' }] })
  settleMember(kim, { answer, timedOut: true, read: '12월 2일 소프트웨이브 https://example.com/a', report: reportData(answer, kim, [], true) ?? null }, 'now', true)
  const shown = mergedReport([kim])
  // c12a B2: a text that states no day of its own gets its date once, after it.
  for (const event of ['소프트웨이브 (12월 2일)', '개발자 행사 (12월 5일)', 'AI 행사 (12월 9일)']) expect(shown).toContain(event)
  expectParts(shown, [['지민', 'https://example.com/a', 'https://example.com/b', 'https://example.com/c']])
  expect(shown).not.toMatch(/한도|여기까지/)
  const data = JSON.parse(reportPrompt('서울 IT 행사 일정 정리해줘', [kim]).split('Data: ')[1]!) as { facts: { text: string; link: string }[] }[]
  expect(data[0]!.facts.map(fact => fact.text)).toEqual(['소프트웨이브 (12월 2일)', '개발자 행사 (12월 5일)', 'AI 행사 (12월 9일)'])
  expect(data[0]!.facts[2]!.link).toContain('(https://example.com/c)')
})

test('c4b r3: with no written answer, a part that read only English pages is said in Korean by one small second ask, with its link (c11a: structure)', async () => {
  // c11a: the teammate says its finding in the person's language (REPORT_RULE), and one writer pass makes the message: no second ask.
  const kim = reported(part('m1', '지민', '노션 신기능 조사', { topic: '노션', sources: ['https://www.notion.com/releases'] }), { facts: [{ text: '워크스페이스 관리 기능이 새로 나왔어요.' }] })
  const park = reported(part('m2', '서연', '슬랙 신기능 조사', { topic: '슬랙' }), { facts: [{ text: '슬랙이 캔버스 공유를 냈어요.', url: 'https://slack.com/blog' }] })
  const asked: string[] = []
  const write = (message: string, kept = ['f1']) => async (prompt: string): Promise<string> => { asked.push(prompt); return JSON.stringify({ message, kept }) }
  const alone = await writtenReport({ ask: '노션 신기능 조사해줘', members: [kim], write: write('노션은 지민이 봤는데 워크스페이스 관리 기능이 새로 나왔어요. [노션](https://www.notion.com/releases)') })
  expectParts(alone, [['지민', 'https://www.notion.com/releases']])
  expect(asked).toHaveLength(1)
  asked.length = 0
  const both = await writtenReport({ ask: '노션, 슬랙 신기능 조사해줘', members: [kim, park], write: write('노션은 지민이 봤는데 관리 기능이 나왔고, 슬랙은 서연이 봤는데 캔버스 공유가 나왔어요. [노션](https://www.notion.com/releases) [슬랙](https://slack.com/blog)', ['f1', 'f2']) })
  expectParts(both, [['지민', 'https://www.notion.com/releases'], ['서연', 'https://slack.com/blog']])
  expect(asked).toHaveLength(1)
  // A text that is English, or names nobody: the host's own rendering with its link; English is never shown.
  for (const bad of ['지민: Agents rebuilt to do more for less', 'New workspace controls were added to every plan', '']) {
    asked.length = 0
    const shown = await writtenReport({ ask: '노션 신기능 조사해줘', members: [kim], write: write(bad) })
    expect(shown).toBe(mergedReport([kim]))
    expectParts(shown, [['지민', 'https://www.notion.com/releases']])
    expect(shown).not.toMatch(/Agents rebuilt|New workspace/)
    expect(asked).toHaveLength(1)
  }
  // Nobody brought data back: nobody is asked at all.
  asked.length = 0
  await writtenReport({ ask: '슬랙 신기능 조사해줘', members: [unreported(part('m2', '서연', '슬랙 신기능 조사', { topic: '슬랙', result: '슬랙이 캔버스 공유를 냈어요 https://slack.com/blog' }))], write: write('') })
  expect(asked).toHaveLength(0)
})

// --- grokbar cycle 5 (c5b) ---
import { lateParts, lateShown, markLate, teamAnswer, teamSummary } from '../src/company-tools.js'
const SEARCHED = 'https://search.naver.com/search.naver?query=%EB%A6%AC%EB%8B%88%EC%96%B4%20%EC%8B%A0%EA%B8%B0%EB%8A%A5'
const teamTask = (members: TeamMember[], over: Partial<DelegatedTask> = {}): DelegatedTask => ({ ...task({ id: 'job', botId: 'lead', state: 'running', goal: '맡긴 일', ...over }), team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })
const unlinked = (text: string): string => text.replace(/\]\(https?:\/\/[^)\s]*\)/g, ')')

test('c5 C5: an address ending in .html is not a file, so the result is the host\'s to write; a file a teammate made is still the lead\'s', async () => {
  // The result as stored in the stack-4 run: the second address was kept as a file and the main model wrote the bubble.
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { state: 'working', background: true })
  // c11a: the teammate hands it back as a report block; an address in it is never taken for a file.
  const answer = block({ facts: [{ text: '소프트웨이브 2026, 코엑스 홀A, 입장 무료', url: 'https://www.coex.co.kr/exhibitions/%EC%A0%9C11%ED%9A%8C/', date: '12월 4일' }, { text: 'ACC 2026, AI·클라우드 행사', url: 'https://itsight.zdnet.co.kr/acc2026/main.html' }] })
  settleMember(kim, { answer, sources: ['https://search.naver.com/search.naver?query=it'], report: reportData(answer, kim, ['https://search.naver.com/search.naver?query=it'], true) ?? null }, 'now', true)
  expect(kim.files).toBeUndefined()
  const asked: string[] = []
  const said = (await employeesAnswer(teamTask([kim]), async prompt => { asked.push(prompt); return undefined }))!
  expect(asked).toHaveLength(1)
  // c11a (structure): the host's rendering, each event with its own link.
  expect(said).toBe(mergedReport([kim]))
  expect(said).toContain('소프트웨이브 2026')
  expectParts(said, [['지민', 'https://www.coex.co.kr/exhibitions/%EC%A0%9C11%ED%9A%8C/', 'https://itsight.zdnet.co.kr/acc2026/main.html']])
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
  const kim = reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { background: true }), { facts: [{ text: '소프트웨이브 2026, 코엑스', url: 'https://www.coex.co.kr/sw', date: '12월 4일' }, { text: 'ACC 2026', url: 'https://itsight.zdnet.co.kr/acc2026/main.html', date: '12월' }] })
  const job = teamTask([kim])
  // The bubble of the stack-4 run.
  const raw = '지민이 다음 달 서울 IT 행사를 조사했어요.\n\n지민\n\n소프트웨이브 2026 — 12/2(수)~12/4(금)\nhttps://www.coex.co.kr/sw\n\nACC 2026은 정확한 날짜를 못 찾았다고 해요.\n\ncoex.co.kr\nitsight.zdnet.co.kr'
  const shown = teamAnswer(raw, job)
  expect(shown).toBe(mergedReport([kim]))
  expect(shown).toContain('[코엑스](https://www.coex.co.kr/sw)')
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

test('c5 C3: a teammate who looked and found nothing new keeps what they read, and their row says so with a link to where they looked (c11a: structure)', async () => {
  const said = '검색 결과에 리니어(Linear) 관련 신기능 소식이 전혀 없네요. 엉뚱한 뉴스·기업 공시 자료만 나와서 관련 정보를 찾지 못했어요.'
  const rows = '어느 회사 3분기 공시: 매출이 늘었다, 11월 14일 https://example.com/ir\n리니어 10월 업데이트 정리: 프로젝트 보기가 바뀌었다, 10월 28일 https://example.com/linear-oct'
  // c11a: nothing new for the time asked is the teammate's own data, with the newest thing it did see.
  const doyun = reported(part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', background: true, sources: [SEARCHED] }), { facts: [], nothing_in_period: { latest: { text: '리니어 10월 업데이트 정리: 프로젝트 보기가 바뀌었어요', url: 'https://example.com/linear-oct', date: '10월 28일' } } })
  expect(doyun).toMatchObject({ state: 'done', empty: true })
  expect(doyun.result).toContain('https://example.com/linear-oct')
  const kim = reported(part('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', { topic: '노션', background: true }), { facts: [{ text: '노션이 AI 회의록을 냈어요', url: 'https://notion.so/releases' }] })
  // The host's own rendering: nothing new, and the latest that names the part as a named link with its day. Never "못 찾았어요".
  const table = mergedReport([kim, doyun])
  const row = table.split('\n\n').find(one => one.includes('(도윤)'))!
  expect(row).toMatch(/새로 나온 게 없어요/)
  expect(row).toContain('10월 28일')
  expectParts(row, [['도윤', 'https://example.com/linear-oct']])
  expect(table).not.toMatch(/못 찾았어요|공시|검색 결과/)
  // No page was loaded at all and no report: only then "못 찾았어요".
  const none = part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', state: 'working' })
  settleMember(none, { answer: said }, 'now', true)
  expect(none.empty).toBeUndefined()
  expect(mergedReport([kim, none]).split('\n\n').at(-1)).toBe('리니어(도윤): 이번엔 못 찾았어요.')
  // A helper with no report: what it read stays, and an answer that names its page is not a found-nothing one.
  const legacy = part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', state: 'working', lookup: true })
  settleMember(legacy, { answer: said, read: rows, sources: [SEARCHED] }, 'now', true)
  expect(legacy).toMatchObject({ state: 'done', read: true, empty: true })
  const some = part('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', { state: 'working' })
  settleMember(some, { answer: '이번 주 신기능 발표는 없어요. 11월 2일 크레딧 정책만 바뀌었어요 https://example.com/credit', read: rows, sources: [SEARCHED] }, 'now', true)
  expect(some.empty).toBeUndefined()
  expect(some.result).not.toContain('linear-oct')
  // The writer is told, is given the latest with its link, and its message is checked: that link is needed.
  const data = JSON.parse(reportPrompt('경쟁사 신기능 조사', [kim, doyun]).split('Data: ')[1]!) as { nothing?: { latest?: { text: string; date?: string; link: string } } }[]
  // c12a B2: the day is in the text once, never a field to put in front of it again.
  expect(data[1]!.nothing?.latest?.text).toBe('리니어 10월 업데이트 정리: 프로젝트 보기가 바뀌었어요 (10월 28일)')
  expect(data[1]!.nothing?.latest?.date).toBeUndefined()
  expect(data[1]!.nothing?.latest?.link).toContain('(https://example.com/linear-oct)')
  const head = '둘 다 찾아봤어요.\n\n노션은 지민이 봤는데 AI 회의록을 냈어요. [노션](https://notion.so/releases)\n\n'
  const said2 = (text: string): string => JSON.stringify({ message: text, kept: ['f1'] })
  expect(checkedReport(said2(`${head}리니어는 도윤이 봤는데 이번엔 못 찾았어요.`), [kim, doyun])).toBeUndefined()
  expect(checkedReport(said2(`${head}리니어는 도윤이 봤는데 이번 주 새 소식은 안 보여요.`), [kim, doyun])).toBeUndefined()
  const good = `${head}리니어는 도윤이 봤는데 이번 주 새 소식은 안 보여요. 가장 최근은 10월 28일 프로젝트 보기 개편이에요. [출처](https://example.com/linear-oct)`
  const checked = checkedReport(said2(good), [kim, doyun])
  expectParts(checked, [['지민', 'https://notion.so/releases'], ['도윤', 'https://example.com/linear-oct']])
  expect(await writtenReport({ ask: '경쟁사 신기능 조사', members: [kim, doyun], write: async () => said2(good) })).toBe(checked)
  // No latest that names the part: the row links the page they searched on.
  const plain = reported(part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', sources: [SEARCHED] }), { facts: [], nothing_in_period: {} })
  expect(mergedReport([plain])).toMatch(/새로 나온 게 없어요/)
  expectParts(mergedReport([kim, plain]), [['지민', 'https://notion.so/releases'], ['도윤', SEARCHED]])
})

test('c5 C4: "다들 뭐 하고 있어?" is a sentence or two: people in the same state together, a shared job once', async () => {
  const c = await company()
  await c.run({ add: [{ name: '지민', role: '리서치 담당' }] })
  const now = Date.parse('2026-11-16T01:10:00.000Z')
  const one = await loadBots(c.paths), kim = one.find(bot => bot.name === '지민')!.id
  const did = (id: string, botId: string, topic: string): TeamMember => member({ id, botId, state: 'released', brief: `이번 주 ${topic} 신기능 조사해서 알려줘`, topic, result: 'x', finishedAt: '2026-11-16T01:05:00.000Z' })
  // One teammate: one sentence.
  expect(companyStatus(one, [], now)).toBe('아직 지민한테 맡긴 일이 없어요.')
  expect(companyStatus(one, [teamTask([did('m1', kim, '노션')], { state: 'done' })], now)).toBe('지민은 이번 주 노션 신기능 조사를 방금 끝냈어요. 지금은 하는 일 없어요.')
  await c.run({ add: [{ name: '서연', role: '카피 담당' }, { name: '도윤', role: '리서치 담당' }] })
  const bots = await loadBots(c.paths), id = (name: string) => bots.find(bot => bot.name === name)!.id
  const split = teamTask([did('m1', id('지민'), '노션'), did('m2', id('서연'), '슬랙'), did('m3', id('도윤'), '리니어')], { state: 'done' })
  // Everyone idle: what the jobs share is said once.
  const idle = companyStatus(bots, [split], now)
  // c7 C4 (USER-NOTES): what they just did first, idle once and plainly, and nobody is "쉬고 있".
  expect(idle).toBe('지민, 서연, 도윤 다 방금 노션·슬랙·리니어 신기능 조사 끝내서 지금은 한가해요.')
  expect(idle).not.toContain('\n')
  // Later the same work is not "방금".
  expect(companyStatus(bots, [split], now + 5 * 3_600_000)).toBe('지민은 노션, 서연은 슬랙, 도윤은 리니어 신기능 조사를 끝낸 게 마지막이에요. 지금은 다들 한가해요.')
  // Mixed: who is on what first, the rest in one clause.
  const busy = teamTask([member({ id: 'm1', botId: id('지민'), state: 'working', brief: '다음 달 서울 IT 행사 일정 정리' })], { id: 'next', state: 'waiting' })
  expect(companyStatus(bots, [split, busy], now)).toBe('지민은 다음 달 서울 IT 행사 일정 정리하고 있고, 서연이랑 도윤은 지금 하는 일 없어요.')
  // A job two people share is said once; a job named by a verb is said as one.
  const shared = teamTask([member({ id: 'm1', botId: id('지민'), state: 'working', brief: '경쟁사 조사' }), member({ id: 'm2', botId: id('서연'), state: 'working', brief: '경쟁사 조사' }), member({ id: 'm3', botId: id('도윤'), state: 'working', brief: '홍보 문구 3개 뽑기' })], { state: 'waiting' })
  expect(companyStatus(bots, [shared], now)).toBe('지민이랑 서연은 경쟁사 조사하고 있고, 도윤은 홍보 문구 3개 뽑고 있어요.')
  // Everyone finished the same job.
  const same = teamTask([member({ id: 'm1', botId: id('지민'), state: 'done', brief: '경쟁사 조사', finishedAt: '2026-11-16T01:05:00.000Z' }), member({ id: 'm2', botId: id('서연'), state: 'done', brief: '경쟁사 조사', finishedAt: '2026-11-16T01:05:00.000Z' })], { state: 'done' })
  expect(companyStatus(bots.filter(bot => bot.name !== '도윤'), [same], now)).toBe('지민이랑 서연은 경쟁사 조사를 방금 끝냈어요. 지금은 둘 다 한가해요.')
  // Every name and a word for the state are always there.
  const every = [idle, companyStatus(bots, [], now), companyStatus(bots, [split, busy], now), companyStatus(bots, [shared], now), companyStatus(bots, [split], now + 5 * 3_600_000)]
  for (const said of every) for (const name of ['지민', '서연', '도윤']) expect(said).toContain(name)
  // c7: no branch says "쉬고 있", BAR C4's word check passes on each, and asked twice in a row the second answer is another sentence.
  for (const [said, tasks] of [[idle, [split]], [every[1]!, []], [every[2]!, [split, busy]], [every[3]!, [shared]]] as const) {
    const again = companyStatus(bots, tasks, now, said)
    for (const one of [said, again]) { expect(one).not.toContain('쉬고 있'); expect(one).toMatch(/대기|쉬|한가|작업|진행|조사|없/); for (const name of ['지민', '서연', '도윤']) expect(one).toContain(name) }
    expect(again).not.toBe(said)
    expect(companyStatus(bots, tasks, now, '다른 답')).toBe(said)
  }
  expect(companyStatus(bots, [split], now, idle)).toBe('지민은 노션, 서연은 슬랙, 도윤은 리니어 신기능 조사를 방금 끝냈어요. 아직 다들 새로 맡은 일은 없어요.')
})

test('c5 C6: links that follow each other in a written answer are set apart', () => {
  // c12a B3: one teammate's two facts on one line are refused (one per line), so the two links here are two teammates' finds.
  const kim = reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리'), { facts: [{ text: '소프트웨이브', url: 'https://a.example.com/sw' }] })
  const seo = reported(part('m2', '서연', '다음 달 광주 IT 행사 일정 정리'), { facts: [{ text: 'ACC', url: 'https://b.example.com/acc' }] })
  const said = (message: string): string => JSON.stringify({ message, kept: ['f1', 'f2'] })
  // c11a: each link is named by its site from the data (the host as the last resort, never 출처).
  const apart = checkedReport(said('지민이랑 서연이 정리해 왔어요.\n\n12월에 둘 다 열려요. [소프트웨이브 2026](https://a.example.com/sw) [ACC 2026](https://b.example.com/acc)'), [kim, seo])
  expect(apart).toMatch(/\]\(https:\/\/a\.example\.com\/sw\) · \[[^\]]+\]\(https:\/\/b\.example\.com\/acc\)/)
  expectParts(apart, [['지민', 'https://a.example.com/sw'], ['서연', 'https://b.example.com/acc']])
  // Already set apart, or glued: one separator either way.
  expect(checkedReport(said('지민이랑 서연이 정리해 왔어요.\n\n둘 다 열려요. [소프트웨이브 2026](https://a.example.com/sw)[ACC 2026](https://b.example.com/acc)'), [kim, seo])).toContain('sw) · [')
  expect(checkedReport(said('지민이랑 서연이 정리해 왔어요.\n\n둘 다 열려요. [소프트웨이브 2026](https://a.example.com/sw) · [ACC 2026](https://b.example.com/acc)'), [kim, seo])).not.toContain('· ·')
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
  // c7 C10: short sentences, one plain statement each, the way a person recaps a week.
  const good = '월요일에 지우가 노션 신기능을 살펴봤는데 새 발표는 없었어요. 서연은 슬랙에서 세일즈포스 에이전트 스워밍 기능을 찾았어요. 지우 조사로 홍보 문구 3개도 썼고요.'
  expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async prompt => { asked.push(prompt); return good } })).toBe(good)
  expect(asked[0]).toContain('two or three short sentences')
  // One small ask: the jobs of this week only, each with who and the day in words, no address. c9 fix 5: the span is not said again in a job.
  expect(asked).toHaveLength(1)
  expect(asked[0]!.length).toBeLessThan(3000)
  const record = JSON.parse(asked[0]!.split('Record: ')[1]!) as { who: string; did: string; got: string; day: string; from?: string }[]
  expect(record.map(job => [job.who, job.did, job.day])).toEqual([['지우', '노션 신기능 조사', '월요일'], ['서연', '슬랙 신기능 조사', '월요일'], ['서연', '홍보 문구 3개 뽑기', '월요일']])
  expect(record[2]!.from).toBe('지우')
  expect(asked[0]).not.toMatch(/https?:\/\/|2026-11/)
  // c9 fix 5: asked about this week, the summary speaks in it, with no day word per job (C10 opened "오늘").
  expect(asked[0]).toContain('start with exactly "이번 주엔" and use no other day or time word')
  // A text the person should not read gives way to the host's own sentence: a list, a raw day, an address, someone left out, nothing at all.
  // c9 fix 5: the host's own summary speaks in the span asked, says the span once, and puts the found-nothing jobs in one sentence of their own.
  const plain = '이번 주엔 서연은 슬랙 신기능 조사를 했어요. 지우가 찾은 걸로 홍보 문구 3개 뽑았어요. 지우가 본 노션 신기능은 새로 나온 게 없었어요.'
  // c7 C10: the clause chain the run showed ("…했는데 …없었고, …도 …없었어요") and five sentences are refused too.
  for (const bad of ['월요일에 지우가 노션 신기능을 조사했는데 이번 주 새 소식은 없었고, 서연이 살펴본 것도 새로운 발표는 없었어요.', '월요일에 지우가 노션을 봤어요. 새 발표는 없었어요. 서연은 슬랙을 봤어요. 스워밍 기능을 찾았어요. 문구도 썼어요.', '- 지우: 노션 조사\n- 서연: 슬랙 조사', '지우와 서연이 2026-11-16에 조사했어요.', '지우와 서연이 조사했어요. https://example.com', '지우가 노션을 조사했어요.', '', undefined]) expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async () => bad })).toBe(plain)
  expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async () => { throw new Error('no') } })).toBe(plain)
  expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, timeoutMs: 10, write: () => new Promise(() => undefined) })).toBe(plain)
  // Nothing in the time asked is said by the host; the kept weekly ask ("지난주 …") reads last week.
  expect(await teamSummary(c.paths, { bots, message: '지난주 팀이 한 일 요약해줘', now, write: async () => good })).toBe('지난주엔 아직 팀이 끝낸 일이 없어요.')
  const later = JSON.parse((await (async () => { const seen: string[] = []; await teamSummary(c.paths, { bots, message: '매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘', now: new Date(2026, 10, 23, 9), write: async prompt => { seen.push(prompt); return good } }); return seen[0]! })()).split('Record: ')[1]!) as { day: string }[]
  expect(later.map(job => job.day)).toEqual(['11월 16일', '11월 16일', '11월 16일'])
  // With no quick model the lead answers from the record in its prompt.
  expect(await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now })).toBeUndefined()
})

test('c5 rule 7: a part still at work when the others are reported is labeled there and reported alone afterwards (c11a: structure)', async () => {
  const kim = reported(part('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', { topic: '노션', background: true }), { facts: [{ text: '노션이 AI 회의록을 냈어요', url: 'https://notion.so/releases' }] })
  const doyun = part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', background: true, state: 'working' })
  const job = teamTask([kim, doyun], { state: 'waiting' })
  expect(lateParts(job)).toEqual(['m3'])
  expect(markLate(job)).toEqual(['m3'])
  expect(lateParts(job)).toEqual([])
  const first = employeesReport(job)!
  // Its own labeled block, after the part that is back.
  expect(first.split('\n\n')).toHaveLength(2)
  expectParts(first.split('\n\n')[0], [['지민', 'https://notion.so/releases']])
  expect(first.split('\n\n')[1]).toBe('리니어(도윤): 아직 찾는 중이에요. 끝나면 이어서 올릴게요.')
  // The writer is told, and a message that hides it is refused.
  const view = [kim, { ...doyun }]
  expect(JSON.parse(reportPrompt('조사', view).split('Data: ')[1]!)[1]).toMatchObject({ name: '도윤', still: true })
  const said = (message: string): string => JSON.stringify({ message, kept: ['f1'] })
  expect(checkedReport(said('하나는 끝났어요.\n\n노션은 지민이 봤는데 AI 회의록을 냈어요. [노션](https://notion.so/releases)\n\n리니어는 도윤이 이번엔 못 찾았어요.'), view)).toBeUndefined()
  expect(checkedReport(said('하나는 끝났어요.\n\n노션은 지민이 봤는데 AI 회의록을 냈어요. [노션](https://notion.so/releases)\n\n리니어는 도윤이 아직 찾는 중이에요. 끝나면 이어서 올릴게요.'), view)).toBeDefined()
  // It lands before that report is read: the report still says what it promised.
  Object.assign(doyun, reported(doyun, { facts: [{ text: '리니어가 새 보기를 냈어요', url: 'https://linear.app/changelog' }] }))
  expect(doyun.state).toBe('done')
  expect(employeesReport(job)).toBe(first)
  // Once that report is in the thread, the next one is the late part alone.
  lateShown(job)
  const late = employeesReport(job)!
  expectParts(late, [['도윤', 'https://linear.app/changelog']])
  expect(late).not.toContain('지민')
  expect(late).toContain('리니어가 새 보기를 냈어요')
  // Nothing back yet, or a hand-off under way: nothing to report early.
  expect(lateParts(teamTask([{ ...kim, state: 'working', result: undefined }, { ...doyun, state: 'working', late: undefined }]))).toEqual([])
  expect(lateParts(teamTask([{ ...kim, then: { botId: 'b', who: '서연', brief: '문구' } }, part('m2', '서연', handoffBrief('문구 쓰기', '지민', 'x'), { background: true, state: 'working' })]))).toEqual([])
})

// c5b review r1: the C3 record kept no read text, only the page searched on, and the row still read "이번엔 못 찾았어요." with no link.
test('c5b r2 C3: a part that searched and kept no text still says where it looked, as a named link, and the writer may not drop that link (c11a: structure)', () => {
  const kim = reported(part('m1', '지민', '이번 주 노션 신기능 조사', { background: true, lookup: true, topic: '노션' }), { facts: [{ text: '노션이 새 보기를 냈어요', url: 'https://example.com/a' }] })
  const doyun = reported(part('m3', '도윤', '이번 주 리니어 신기능 조사', { background: true, lookup: true, topic: '리니어', sources: ['https://search.naver.com/search.naver?query=linear'] }), { facts: [], nothing_in_period: {} })
  expect(doyun.empty).toBe(true)
  const row = mergedReport([kim, doyun]).split('\n\n').find(one => one.includes('(도윤)'))!
  expect(row).toMatch(/새로 나온 게 없어요/)
  expect(row).not.toContain('못 찾았')
  const table = (line: string): string => JSON.stringify({ message: `둘 다 찾아봤어요.\n\n노션은 지민이 봤는데 새 보기를 냈어요. [출처](https://example.com/a)\n\n리니어는 도윤이 ${line}`, kept: ['f1'] })
  expect(checkedReport(table('봤는데 이번 주 새 소식은 안 보여요. [네이버](https://search.naver.com/search.naver?query=linear)'), [kim, doyun])).toBeDefined()
  // Where they looked is linked, in the host's rendering and in the writer's.
  expectParts(row, [['도윤', 'https://search.naver.com/search.naver?query=linear']])
  expect(checkedReport(table('봤는데 이번 주 새 소식은 안 보여요.'), [kim, doyun])).toBeUndefined()
})

// c5b review r1: "example.com/report.html" was kept as a file and shown as written.
test('c5b r2 C5: an address written without its scheme is not a file and never reaches the thread raw', () => {
  const kim = part('m1', '지민', '행사 조사', { state: 'working', background: true })
  settleMember(kim, { answer: 'example.com/report.html' }, 'now', true)
  expect(kim.files).toBeUndefined()
  // c11a: the teammate's own data gives the page; the host names it by its host when it knows no other name (never "source").
  const shown = teamAnswer('example.com/report.html', teamTask([reported(kim, { facts: [{ text: '행사 보고서', url: 'https://example.com/report.html' }] })]))
  expect(shown).toMatch(/\[[^\]]+\]\(https:\/\/example\.com\/report\.html\)/)
  expect(shown).not.toMatch(/\[(?:source|출처)\]/)
  expect(shown.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(/example\.com/)
  // Inside a sentence the main model wrote, with a file the host's list cannot carry: repaired where it stands, the full stop kept.
  const park = part('m2', '서연', '보고서 만들기', { state: 'working', background: true, lookup: false })
  settleMember(park, { answer: '보고서를 만들었어요. reports/3분기.docx 에 있어요.' }, 'now', true)
  expect(teamAnswer('서연이 만들었어요. [3분기.docx](engram-artifact:a.docx) 참고는 www.coex.co.kr/sw.', teamTask([park]))).toBe('서연이 만들었어요. [3분기.docx](engram-artifact:a.docx) 참고는 [코엑스](https://www.coex.co.kr/sw).')
  // Words with a dot and a slash that are no address, a named link and a workspace file stand.
  for (const fine of ['node.js/express 로 만들었어요.', '[coex.co.kr/sw](https://www.coex.co.kr/sw) 에 있어요.', 'reports/q3.docx 에 있어요.']) expect(teamAnswer(fine, teamTask([park]))).toBe(fine)
})

test('c5b r3 C5: an address on any ending is an address, a name that ends like a file or a library is not', () => {
  // The reviewer's case: ".gg" was not in the list of known endings and reached the thread as written.
  const kim = reported(part('m1', '지민', '행사 조사', { background: true }), { facts: [{ text: '행사 안내', url: 'https://example.gg/report.html' }] })
  const shown = teamAnswer('행사 안내 example.gg/report.html', teamTask([kim]))
  expectParts(shown, [['지민', 'https://example.gg/report.html']])
  expect(shown.replace(/\[[^\]]*\]\([^)]*\)/g, '')).not.toMatch(/example\.gg/)
  const park = part('m2', '서연', '보고서 만들기', { state: 'working', background: true, lookup: false })
  settleMember(park, { answer: '보고서를 만들었어요. reports/3분기.docx 에 있어요.' }, 'now', true)
  // stack-6: the link is named like any other source, never by its bare host (team-hire-tools sourceName).
  // c7: nor by a piece of the host ("seoul", "luma"). c11a R2: a site the host does not know is named by its whole host, never "출처".
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
  // c11a: as a teammate it hands back nothing new with the newest page it saw, and its row links that page.
  const kim = reported(part('m1', '지민', '이번 주 노션 신기능 조사', { background: true, topic: '노션' }), { facts: [{ text: '노션이 새 보기를 냈어요', url: 'https://example.com/a' }] })
  const said = reported(part('m3', '도윤', '이번 주 리니어 신기능 조사', { background: true, topic: '리니어', sources }), { facts: [], nothing_in_period: { latest: { text: '리니어 10월 업데이트 정리: 새 보기', url: 'https://news.example/linear-october', date: '10월 28일' } } })
  const row = mergedReport([kim, said]).split('\n\n').find(one => one.includes('(도윤)'))!
  expect(row).toMatch(/새로 나온 게 없어요/)
  expectParts(row, [['도윤', 'https://news.example/linear-october']])
  // With no result that names the part, the link is the page it searched on.
  const plain = reported(part('m4', '도윤', '이번 주 리니어 신기능 조사', { background: true, topic: '리니어', sources }), { facts: [], nothing_in_period: {} })
  expect(mergedReport([plain])).toMatch(/새로 나온 게 없어요/)
  expect(mergedReport([plain])).toContain(`](${sources[0]})`)
})

test('stack-5: a team result never names a link "네이버 블로그", whoever wrote it, and the host\'s own list never does', () => {
  const kim = part('m1', '지민', '이번 주말 서울 날씨 조사', { background: true, topic: '서울', result: '주말은 맑아요. [주말 나들이 날씨 정리](https://blog.naver.com/traveltrap/1)', sources: ['https://search.naver.com/search.naver?query=seoul'] })
  const lee = part('m2', '서연', '부산 날씨 조사', { background: true, topic: '부산', result: '부산은 흐려요 https://cafe.naver.com/busan/2' })
  const written = '지민이랑 서연이 알아봤어요.\n\n| 항목 | 내용 |\n| --- | --- |\n| 서울 (지민) | 주말은 맑아요. [네이버 블로그](https://blog.naver.com/traveltrap/1) |\n| 부산 (서연) | 흐려요. [네이버 카페](https://cafe.naver.com/busan/2) |'
  const shown = teamAnswer(written, teamTask([kim, lee]))
  expect(shown).toContain('[주말 나들이 날씨 정리](https://blog.naver.com/traveltrap/1)')
  // c9a R2: a post is named by its platform.
  expect(shown).toContain('[네이버 카페](https://cafe.naver.com/busan/2)')
  // c9a R2: the platform is now the link's own name; never as plain words beside a link.
  for (const text of [shown, mergedReport([kim, lee])]) expect(text).not.toMatch(/(?<!\[)네이버 (?:블로그|카페)(?!\])/)
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
  expect(out).toContain('| [네이버 블로그](https://blog.naver.com/example/1) |')
  expect(out).not.toMatch(/네이버 검색|(?<!\[)네이버 블로그(?!\])/)
  // No post named: the member's page, as before.
  expect(citeMembers('| 제품 | 가격 | 출처 |\n|---|---|---|\n| 갤럭시 S27 | 예상 130만 원 | 네이버 블로그 |', [{ ...m, result: '예상 130만 원' }], true)).toContain('[네이버 검색](https://search.naver.com/search.naver?query=Galaxy+S27+price)')
})

// --- grokbar cycle 6 (c6b): the stored results of the stack-5 run, measured 2026-11-17 on 4e940bf4 ---
import stack5 from './fixtures/grokbar-stack5-team.json' with { type: 'json' }
import { askedPeriod, lastTeamResult, writerMs, REPORT_CAP_MS, REPORT_WRITER_MS, REPORT_WRITER_MAX_MS } from '../src/company-tools.js'
const s5 = { c3: stack5.c3.members as TeamMember[], c5: stack5.c5.members as TeamMember[], c6: stack5.c6.members as TeamMember[] }
const NOV17 = new Date(2026, 10, 17, 9)
const linksIn = (text: string): string[] => [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(hit => hit[1]!)

test('c6 item 1: the writer gets what is left of the report\'s cap, at most 8 s, and before the cap never more than is left', async () => {
  const at = Date.parse('2026-11-17T00:00:00Z'), hired = (agoMs: number): TeamMember[] => [reported(part('m1', '지민', '노션 신기능 조사', { hiredAt: new Date(at - agoMs).toISOString() }), { facts: [{ text: '노션이 AI 회의록을 냈어요.', url: 'https://notion.so/releases' }, { text: '노션 메일도 나왔어요.', url: 'https://notion.so/mail' }] })]
  // 20 s of the cap left: 8 s. 6 s left: those 6 s. 3 s left: those 3 s (c6b r3: it was given 4). At the cap or long past it (a late part's own report): the 4 s it always had.
  expect(writerMs(hired(REPORT_CAP_MS - 20_000), at)).toBe(REPORT_WRITER_MAX_MS)
  expect(REPORT_WRITER_MAX_MS).toBe(8000)
  expect(writerMs(hired(REPORT_CAP_MS - 6000), at)).toBe(6000)
  expect(writerMs(hired(REPORT_CAP_MS - 3000), at)).toBe(3000)
  expect(writerMs(hired(REPORT_CAP_MS - 500), at)).toBe(500)
  expect(writerMs(hired(REPORT_CAP_MS), at)).toBe(REPORT_WRITER_MS)
  expect(writerMs(hired(90_000), at)).toBe(REPORT_WRITER_MS)
  expect(writerMs([part('m1', '지민', '조사')], at)).toBe(REPORT_WRITER_MS)
  // The time is counted from the earliest hand-out, and the writer is told it (the engine's own timeout is that long too).
  expect(writerMs([...hired(REPORT_CAP_MS - 20_000), ...hired(REPORT_CAP_MS - 5000)], at)).toBe(5000)
  const given: (number | undefined)[] = []
  const members = hired(5000), good = JSON.stringify({ message: '노션은 지민이 봤는데 이번 주에 AI 회의록을 냈어요. [노션](https://notion.so/releases)\n노션 메일도 나왔어요. [노션](https://notion.so/mail)', kept: ['f1', 'f2'] })
  const shown = await writtenReport({ ask: '노션 신기능 조사해줘', members, now: new Date(at), write: async (_prompt, ms) => { given.push(ms); return good } })
  expect(shown).toBe(checkedReport(good, members))
  expectParts(shown, [['지민', 'https://notion.so/releases', 'https://notion.so/mail']])
  expect(given).toEqual([8000])
  // A writer that does not make it: the host's own list stands in, as before.
  const slow = hired(REPORT_CAP_MS - 3000)
  expect(await writtenReport({ ask: '노션 신기능 조사해줘', members: slow, timeoutMs: 20, write: () => new Promise(resolve => setTimeout(() => resolve(good), 200)) })).toBe(mergedReport(slow))
  // The prompt stays small: three teammates' results as measured (5,780 characters then) are under 8k with the added rules.
  expect(reportPrompt(stack5.c3.goal, s5.c3, undefined, { now: NOV17 }).length).toBeLessThan(9000)
})

test('c6 item 2 (C3): the host\'s own table reads like a person wrote it: no sentence that only says it looked, no repeated label or heading, one named link per part (c11a: structure)', () => {
  const byok = 'https://linear.app/changelog/2026-11-12-bring-your-own-key'
  // c11a: the stored run as each teammate hands it back now, as data (the finding only, no "확인했어요" sentence and no "리니어 신기능:" label).
  const c3 = [
    reported(s5.c3[0]!, { facts: [], nothing_in_period: { latest: { text: '노션, 네트워크 없이도 작업 가능한 \'오프라인 모드\' 출시', url: 'https://www.hellot.net/news', site: '헬로티', date: '2025년 8월 19일' } } }),
    reported(s5.c3[1]!, { facts: [{ text: 'Slack이 Salesforce 에이전트 스워밍 기능을 제공해요.', url: 'https://slack.com/intl/ko-kr/help/articles/115004846068', site: 'Slack', date: '2026년 11월' }] }),
    reported(s5.c3[2]!, { facts: [{ text: 'BYOK(자체 API 키 연결)로 클라우드 코딩 에이전트에 자체 API 키를 쓸 수 있어요.', url: byok, site: 'Linear', date: '11월 12일' }] }),
  ]
  const table = mergedReport(c3), rows = table.split('\n\n')
  // c7: no table; each teammate's block opens on their part and their name.
  expect(rows.map(row => row.split(': ')[0])).toEqual(['노션(지민)', '슬랙(서연)', '리니어(도윤)'])
  expect(table).not.toMatch(/^\|/m)
  // The three sentences of the run that were no finding.
  expect(table).not.toMatch(/소식 확인했어요|항목이 확인됐어요|조사 결과/)
  // The finding comes first, without the label that repeats the row's first cell.
  // c12a B2: the day once, after a text that states none.
  expect(rows[2]).toMatch(/^리니어\(도윤\): BYOK\(자체 API 키 연결\).* 쓸 수 있어요 \(11월 12일\)\. \[/)
  expect(rows[2]).not.toContain('리니어 신기능:')
  // One link per part: the page the finding came from, named by the site (never 출처); never a row that was only read.
  for (const row of rows) expect(linksIn(row), row).toHaveLength(1)
  expect(linksIn(rows[2]!)).toEqual([byok])
  expectParts(table, [['지민', 'https://www.hellot.net/news'], ['서연', 'https://slack.com/intl/ko-kr/help/articles/115004846068'], ['도윤', byok]])
  expect(table).not.toMatch(/linearcollider|shopping\.naver|\[slack\.com\]|\[hellot\.net\]/)
  expect(rows[0]).toContain('[헬로티](https://www.hellot.net/news)')
  // A label that is the finding's own title stays ("노션 3.0 출시: …" is no repeat of "노션").
  expect(mergedReport([reported(part('m1', '지민', '노션 조사', { topic: '노션' }), { facts: [{ text: '노션 3.0 출시: AI 회의록이 추가됐어요.', url: 'https://notion.so/a' }] })]))
    // c12a B1: one part alone leads with a plain sentence from data (its name in the person's words, the teammate), not a "part(name):" label.
    .toMatch(/^노션은 지민이 찾아 왔어요\. 노션 3\.0 출시: AI 회의록이 추가됐어요\. \[[^\]]+\]\(https:\/\/notion\.so\/a\)$/)
})

test('c6 item 2 (C5): a line that is only a link joins the line before it, whoever wrote the result; under a list or a table it stays', () => {
  const kim = part('m1', '지민', '서울 날씨 조사', { result: '서울은 12도예요. https://weather.example/seoul' }), job = teamTask([kim])
  expect(teamAnswer('지민이 찾아봤어요.\n\n서울은 지금 12도예요.\n\n[날씨](https://weather.example/seoul)', job)).toBe('지민이 찾아봤어요.\n\n서울은 지금 12도예요. [날씨](https://weather.example/seoul)')
  const list = '지민이 찾아봤어요.\n\n- 서울 12도\n- 부산 15도\n\n[날씨](https://weather.example/seoul)'
  expect(teamAnswer(list, job)).toBe(list)
  const lines = '지민이 찾아봤어요.\n\n서울 12도\n부산 15도\n\n[날씨](https://weather.example/seoul)'
  expect(teamAnswer(lines, job)).toBe(lines)
})

test('c6 item 4 (C5, C6): a find dated outside the time asked is never shown as inside it (c11a: structure)', async () => {
  const ctx = { now: NOV17 }, acc = 'https://itsight.zdnet.co.kr/conference/ACC2025'
  // The time asked, read widely: next month whole, this week from seven days back to Sunday.
  expect(askedPeriod('다음 달 서울 IT 행사 일정 정리', NOV17)).toMatchObject({ from: new Date(2026, 11, 1), to: new Date(2026, 11, 31), label: '올해 12월' })
  expect(askedPeriod('다음 달 일정', new Date(2026, 11, 20))).toMatchObject({ from: new Date(2027, 0, 1), label: '내년 1월' })
  expect(askedPeriod('이번 주 리니어 신기능 조사해서 알려줘', NOV17)).toMatchObject({ from: new Date(2026, 10, 16), to: new Date(2026, 10, 22) })
  expect(askedPeriod('이번 주말 서울 날씨 찾기', NOV17)).toMatchObject({ from: new Date(2026, 10, 21), to: new Date(2026, 10, 22) })
  expect(askedPeriod('내일 날씨', NOV17)).toMatchObject({ from: new Date(2026, 10, 18), to: new Date(2026, 10, 18) })
  expect(askedPeriod('서울 IT 행사 일정 정리', NOV17)).toBeUndefined()
  // C5 as the teammate hands it back now: nothing for next month, and last year's event as the nearest, with its year and its page.
  const c5 = [reported(s5.c5[0]!, { facts: [], nothing_in_period: { latest: { text: 'ACC 2025(AI & Cloud Conference)가 서울 신라호텔에서 열렸어요.', url: acc, site: '지디넷코리아', date: '2025년 12월 11일' } } })]
  const host = mergedReport(c5)
  // c12a B1: no job title as the head; the teammate's name leads.
  expect(host).toMatch(/^지민이 봤는데 이번엔 새로 나온 게 없어요\./)
  expect(host).not.toContain('일정 정리(')
  expect(host).toContain('2025년 12월 11일')
  expectParts(host, [['지민', acc]])
  expect(host.split('\n')).toHaveLength(1)
  // The writer is given that as nothing new, the latest with its year and its link; a message that drops that link is refused.
  const prompt = reportPrompt(stack5.c5.goal, c5, undefined, ctx)
  const data = JSON.parse(prompt.split('Data: ')[1]!) as { nothing?: { latest?: { text: string; link: string } } }[]
  // c12a B2: the day is in the text once (the text names the year only, so the whole date follows it).
  expect(data[0]!.nothing?.latest?.text).toBe('ACC 2025(AI & Cloud Conference)가 서울 신라호텔에서 열렸어요 (2025년 12월 11일).')
  expect(data[0]!.nothing?.latest?.link).toContain(`(${acc})`)
  const said = (message: string): string => JSON.stringify({ message, kept: [] })
  const shown = said('지민이 다음 달 서울 IT 행사 일정 정리해 왔어요.\n\n12월 11일, ACC 2025(AI & Cloud Conference) 신라호텔에서 개최')
  expect(checkedReport(shown, c5)).toBeUndefined()
  const good = said(`다음 달 서울 IT 행사는 지민이 봤는데 아직 올라온 게 없어요. 가장 가까운 건 작년 12월 11일 ACC 2025였어요. [ACC 2025](${acc})`)
  expectParts(checkedReport(good, c5), [['지민', acc]])
  expect(await writtenReport({ ask: stack5.c5.goal, members: c5, now: NOV17, write: async () => shown })).toBe(host)
  expect(await writtenReport({ ask: stack5.c5.goal, members: c5, now: NOV17, write: async () => good })).toBe(checkedReport(good, c5))
  // C6: the hand-over gives the next teammate the giver's data, the year as written and the page, and still reads back as a hand-over.
  const handed = handoffBrief('홍보 문구 3개 뽑기', '지민', c5[0]!.result!, c5[0]!.brief)
  expect(handedFrom(handed)).toMatchObject({ brief: '홍보 문구 3개 뽑기', from: '지민', job: '다음 달 서울 IT 행사 일정 정리' })
  expect(handedFrom(handed)!.result).toContain('이번엔 새로 나온 게 없어요.')
  expect(handedFrom(handed)!.result).toContain(`ACC 2025(AI & Cloud Conference)가 서울 신라호텔에서 열렸어요 (2025년 12월 11일). — ${acc}`)
  // The writer's items are shown exactly, under an opener that links the find they were made from; nothing closes the bubble.
  const items = ['작년 12월 11일 ACC 2025의 열기를 다시 만나요', 'AI와 클라우드, 신라호텔에서 본 내일', '올해도 ACC 소식을 기다려요']
  const seoyeon = reported(part('m2', '서연', handed, { lookup: undefined, writer: true }), { items })
  const c6host = mergedReport([seoyeon]), lines = c6host.split('\n')
  // c12a B1: one plain sentence from data (who, whose find, how many), never the job title "홍보 문구 3개 뽑기(서연, …):".
  expect(lines[0]).toMatch(new RegExp(`^서연이 지민이 찾은 서울 IT 행사 일정으로 3개 써 왔어요\\. \\[[^\\]]+\\]\\(${escaped(acc)}\\)$`))
  expect(lines.slice(1)).toEqual(items.map((item, i) => `${i + 1}. ${item}`))
  expectParts(c6host, [['서연', acc], ['지민']])
  expect(c6host).not.toMatch(/지민이 찾아보니|찾은 내용:/)
  // c9 fix 2: no closing sentence; the writer is told where the find came from and to say it once.
  const c6prompt = reportPrompt(stack5.c6.goal, [seoyeon], undefined, ctx)
  expect(c6prompt).toContain('"madeFrom":"지민"')
  expect(c6prompt).toContain(`(${acc})`)
  expect(c6prompt).toContain('no closing recap')
})

test('c6 item 5 (C10): the weekly summary says what the record says: no example a writer can copy, each job marked found or not, a found job never in a "없었" clause', async () => {
  const c = await company(), now = NOV17
  await c.run({ add: [{ name: '지우', role: '리서치 담당' }, { name: '도윤', role: '리니어 조사 담당' }] })
  const bots = await loadBots(c.paths)
  // The record as the run wrote it (지민 is 지우 now; 서연 was taken off and keeps her name).
  await recordFacts(c.paths, TEAM_MEMORY, stack5.record.map(line => line.replace('(지민, ', '(지우, ').replace('(지민한테 받아서)', '(지우한테 받아서)')), now)
  const asked: string[] = []
  const sum = (text: string) => teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async prompt => { asked.push(prompt); return text } })
  const plain = await teamSummary(c.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async () => '' })
  // What the run showed: 도윤 had found Linear's BYOK and the summary said nothing new was there.
  expect(await sum(stack5.c10)).toBe(plain)
  expect(plain).toContain('도윤')
  // No example names something that can be in the record.
  expect(asked[0]).not.toMatch(/노션이랑 리니어|서연이 지민/)
  expect(asked[0]).toContain('"A랑 B 쪽은 새 소식이 없었어요."')
  const jobs = JSON.parse(asked[0]!.split('Record: ')[1]!) as { who: string; did: string; nothing: boolean }[]
  expect(jobs.map(job => [job.who, job.did, job.nothing])).toEqual([['서연', '슬랙 신기능 조사', false], ['지우', '노션 신기능 조사', false], ['도윤', '리니어 신기능 조사', false], ['지우', '다음 달 서울 IT 행사 일정 정리', false], ['서연', '홍보 문구 3개 뽑기', false], ['지우', '이번 주말 서울 날씨 찾기', false], ['서연', '주말 나들이 추천 문구 한 줄 쓰기', false]])
  // The same summary with the Linear job said as found passes.
  const right = '이번 주엔 서연이 슬랙 신기능을 조사해서 Salesforce 에이전트 스워밍 기능을 확인했어요. 도윤은 리니어에 BYOK가 들어온 걸 찾았고, 지우는 노션이랑 다음 달 서울 IT 행사를 살펴봤어요. 서연이 그 조사로 홍보 문구 3개를 썼어요.'
  expect(await sum(right)).toBe(right)
  // A job that did find nothing may sit in such a clause, alone; a found one beside it may not.
  const d = await company()
  await recordFacts(d.paths, TEAM_MEMORY, ['이번 주 노션 신기능 조사 → 못 찾았어요 (지우, 2026-11-17)', '이번 주 리니어 신기능 조사 → BYOK(자체 API 키 연결)가 11월 12일에 나왔어요. (도윤, 2026-11-17)'], now)
  const two = (text: string) => teamSummary(d.paths, { bots, message: '이번 주 팀이 한 일 요약해', now, write: async prompt => { asked.push(prompt); return text } })
  const fine = '이번 주엔 지우가 노션 쪽을 봤는데 새 소식은 없었어요. 도윤은 리니어에 BYOK가 들어온 걸 찾았어요.'
  expect(await two(fine)).toBe(fine)
  expect((JSON.parse(asked.at(-1)!.split('Record: ')[1]!) as { nothing: boolean }[]).map(job => job.nothing)).toEqual([true, false])
  // Refused; the host's own summary keeps the found job out of its found-nothing sentence (c9: that sentence names only 지우's part).
  const kept = (await two('오늘 지우랑 도윤이 노션이랑 리니어 쪽은 새 소식이 없었어요.'))!
  expect(kept).toBe('이번 주엔 도윤은 리니어 신기능 조사를 했어요. BYOK(자체 API 키 연결)가 11월 12일에 나왔어요. 지우가 본 노션 신기능은 새로 나온 게 없었어요.')
  expect(kept.split(/(?<=[.!?])\s+/).filter(one => one.includes('없었')).join(' ')).not.toMatch(/리니어|도윤/u)
  expect(await two('오늘 지우는 노션을 봤고, 도윤 쪽은 못 찾았어요.')).not.toContain('못 찾았')
  // The record line keeps the finding: the sentence that only says something was confirmed goes before the line is cut to length.
  const e = await company()
  await e.run({ add: [{ name: '도윤', role: '리니어 조사 담당' }] })
  const bot = (await loadBots(e.paths)).find(one => one.name === '도윤')!
  // c11a: the result recorded is the teammate's data in plain lines (dataText): 11월 12일 is before this week (11월 16~22일), so 도윤 handed
  // back nothing new with that as the latest; the line keeps the finding and no address.
  const linear = reported(s5.c3[2]!, { facts: [], nothing_in_period: { latest: { text: 'BYOK(자체 API 키 연결)로 클라우드 코딩 에이전트에서 자체 API 키를 쓸 수 있게 됐어요.', url: 'https://linear.app/changelog/2026-11-12-bring-your-own-key', date: '11월 12일' } } })
  // c12a B4: with the data (as the runner passes it) the line is the job and one short clause on what came of it, no fact sentence.
  await employeeWriteBack(e.paths, { botId: bot.id, brief: linear.brief, result: linear.result!, title: s5.c3[2]!.title!, data: linear.data }, now)
  const line = (await teamRecord(e.paths)).facts[0]!.text
  expect(line).toMatch(/^이번 주 리니어 신기능 조사 → 새로 나온 게 없었어요 \(도윤, /)
  expect(line).not.toMatch(/BYOK|11월 12일/)
  expect(line).not.toMatch(/항목이 확인됐어요|https?:/)
  // A find of another year is recorded as that, and the summary's writer is told the job found nothing for the time asked.
  const acc = reported({ ...s5.c5[0]!, role: '도윤' }, { facts: [], nothing_in_period: { latest: { text: 'ACC 2025가 서울 신라호텔에서 열렸어요.', url: 'https://itsight.zdnet.co.kr/conference/ACC2025', date: '2025년 12월 11일' } } })
  await employeeWriteBack(e.paths, { botId: bot.id, brief: acc.brief, result: acc.result!, title: s5.c5[0]!.title!, data: acc.data }, now)
  expect((await teamRecord(e.paths)).facts[1]!.text).toMatch(/^다음 달 서울 IT 행사 일정 정리 → 새로 나온 게 없었어요 \(도윤, /)
  // c11a: whether a job found nothing is the host's own mark on the part (TeamMember.empty, set from the data), read with the tasks.
  await teamSummary(e.paths, { bots: await loadBots(e.paths), tasks: [teamTask([linear, acc])], message: '이번 주 팀이 한 일 요약해', now, write: async prompt => { asked.push(prompt); return '' } })
  // c10b: 11월 12일 is before this week (11월 16~22일), so the Linear job is recorded as nothing new this week too.
  expect((JSON.parse(asked.at(-1)!.split('Record: ')[1]!) as { nothing: boolean }[]).map(job => job.nothing)).toEqual([true, true])
  // The lead's own note (no quick model) gives no copyable name either.
  expect(await companyNote(e.paths, { bots: await loadBots(e.paths), message: '이번 주 팀이 한 일 요약해', chief: true, now })).not.toMatch(/노션, 슬랙, 리니어 쪽은|서연이 지민 조사로|\(지민, 11월 16일\)/)
})

test('c6 item 6 (C4, C7, C8, H5): a result\'s lead follows the job\'s own verb, answers in its first sentence when there is one finding, and never ends like the lead before it (c11a: structure)', async () => {
  // c11a: the host writes no lead sentence of its own. Its first line is the part (its job) and whose it is, and the finding is on that
  // same line when there is one; several follow under it. The writer is handed the thread's last team message so it never opens the same way.
  const first = (brief: string, report: Record<string, unknown>, more: Partial<TeamMember> = {}): string => mergedReport([reported(part('m1', '지민', brief, more), report)]).split('\n')[0]!
  const two = { facts: [{ text: '소프트웨이브가 열려요.', url: 'https://a.example/sw', date: '12월 2일' }, { text: 'AI 서밋이 열려요.', url: 'https://a.example/ai', date: '12월 9일' }] }
  // c12a B1: the first line is who brought how many, from data; never the job's title.
  expect(first('서울 IT 행사 조사', two)).toBe('지민이 2개를 찾아 왔어요.')
  expect(first('다음 달 서울 IT 행사 일정 정리', two)).toBe('지민이 2개를 찾아 왔어요.')
  expect(first('다음 달 서울 IT 행사 일정 정리', two, { topic: 'IT 행사' })).toBe('지민이 IT 행사 2개를 찾아 왔어요.')
  expect(first('홍보 문구 3개 써줘', { items: ['가', '나', '다'] }, { lookup: false, writer: true })).toBe('지민이 3개 써 왔어요.')
  // One finding: the teammate's own sentence on the first line, with its link.
  const one = { facts: [{ text: '원달러 환율은 지금 1달러에 1,385원이에요.', url: 'https://finance.example/usd' }] }
  expect(first('원달러 환율 알아봐', one)).toMatch(/^지민이 찾아 왔어요\. 원달러 환율은 지금 1달러에 1,385원이에요\. \[[^\]]+\]\(https:\/\/finance\.example\/usd\)$/)
  // The table's lead too: no "둘 다 찾아봤어요" line; each part opens on its name.
  const pair = [reported(part('m1', '지민', '노션 신기능 조사', { topic: '노션' }), { facts: [{ text: '노션이 AI 회의록을 냈어요.', url: 'https://notion.so/a' }] }), reported(part('m2', '서연', '슬랙 신기능 조사', { topic: '슬랙' }), { facts: [{ text: '슬랙이 허들 요약을 냈어요.', url: 'https://slack.com/b' }] })]
  expect(mergedReport(pair).split('\n\n').map(row => row.split(': ')[0])).toEqual(['노션(지민)', '슬랙(서연)'])
  expectParts(mergedReport(pair), [['지민', 'https://notion.so/a'], ['서연', 'https://slack.com/b']])
  // Never like the lead before it: the writer gets the thread's last team message.
  const previous = '도윤: 리니어 신기능 찾아봤어요.'
  expect(reportPrompt('노션, 슬랙 신기능 알려줘', pair, undefined, { previous })).toContain(previous)
  expect(reportPrompt('노션, 슬랙 신기능 알려줘', pair)).not.toContain(previous)
  // No 보고, no status word, 해요체, in every form the host writes.
  for (const brief of ['서울 IT 행사 조사', '서울 IT 행사 일정 정리', '후보 고르기', '날씨']) expect(mergedReport([reported(part('m1', '지민', brief), two)]), brief).not.toMatch(/보고|완료|처리|습니다|찾아봤어요|정리해 왔어요/)
  // The thread's last team result: another finished job's, or this job's own first report once a late part follows.
  const done = teamTask([part('m1', '지민', '조사')], { id: 'a', state: 'done', result: '지민이 찾아봤어요.', updatedAt: '2026-11-17T00:00:01Z' })
  const now = teamTask([part('m1', '지민', '조사')], { id: 'b', result: '지민한테 맡겼어요.', updatedAt: '2026-11-17T00:00:02Z' })
  expect(lastTeamResult([done, now], now)).toBe('지민이 찾아봤어요.')
  expect(lastTeamResult([done, { ...now, team: { ...now.team!, lateTold: true }, result: '표' }], now)).toBe('표')
  expect(lastTeamResult([{ ...done, botId: 'other' }, now], now)).toBeUndefined()
})

test('c6 item 7: a late part that never came is one plain line, not silence and not a table of one', () => {
  const kim = reported(part('m1', '지민', '이번 주 노션 신기능 조사해서 알려줘', { topic: '노션', background: true }), { facts: [{ text: '노션이 AI 회의록을 냈어요.', url: 'https://notion.so/releases' }] })
  const doyun = part('m3', '도윤', '이번 주 리니어 신기능 조사해서 알려줘', { topic: '리니어', background: true, state: 'working' })
  const job = teamTask([kim, doyun], { state: 'waiting' })
  markLate(job); lateShown(job)
  // It died with the app (team-hire-tools failOnRestart).
  Object.assign(doyun, { state: 'failed', result: 'Failed: the app restarted while this member was working.' })
  // c12a B1: alone in its own report, the part is said in a sentence: its name in the person's words and who.
  expect(employeesReport(job)).toBe('리니어는 도윤이 끝까지 못 찾았어요.')
  lateShown(job)
  expect(job.team).toMatchObject({ lateTold: true, lateDone: true })
})

test('c6b r3: copy made from last year\'s event says the year in its first line and no line sells it as next month\'s (c11a: structure)', async () => {
  const acc = 'https://example.com/acc'
  // c11a: the giver hands back last year's event as the nearest, with its year; the writer reads that data, the year as written.
  const kim = reported(part('m0', '지민', '다음 달 서울 IT 행사 일정 정리', { then: { botId: 'bot-m1', who: '서연', brief: '홍보 문구 3개 뽑기' } }), { facts: [], nothing_in_period: { latest: { text: 'ACC 2025가 서울에서 열렸어요.', url: acc, date: '2025년 12월 11일' } } })
  const brief = handoffBrief('홍보 문구 3개 뽑기', '지민', kim.result!, kim.brief)
  // c12a B2: the date once, after a text that does not state it.
  expect(brief).toContain(`ACC 2025가 서울에서 열렸어요 (2025년 12월 11일). — ${acc}`)
  expect(brief).toContain('이번엔 새로 나온 게 없어요.')
  const items = ['작년 12월 11일 ACC 2025, 그 열기를 기억하세요.', 'ACC 2025를 돌아봐요.', '올해 ACC 소식도 곧 전할게요.']
  const seoyeon = reported(part('m1', '서연', brief, { lookup: undefined, writer: true }), { items })
  const host = mergedReport([kim, seoyeon])
  // The first line links the find it was made from (its year is on that page and in the brief); the items are exactly the writer's, and
  // nothing the host adds sells them as next month's; nothing closes the bubble.
  const lines = host.split('\n')
  expect(lines[0]).toBe(`서연이 지민이 찾은 서울 IT 행사 일정으로 3개 써 왔어요. [example.com](${acc})`)
  expect(lines.slice(1)).toEqual(items.map((item, i) => `${i + 1}. ${item}`))
  expect(host).not.toMatch(/다음 달|12월에 열려요/)
  // The writer's text: an item changed (made into next month's) or the find's link dropped is refused; the host's list stands in.
  const said = (message: string): string => JSON.stringify({ message, kept: [] })
  const good = `서연이 지민이 찾은 작년 ACC 소식으로 세 개 뽑아 봤어요. [ACC](${acc})\n\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`
  expectParts(checkedReport(said(good), [kim, seoyeon]), [['서연', acc], ['지민']])
  for (const bad of [good.replace('3. 올해 ACC 소식도 곧 전할게요.', '3. 다음 달 서울에서 만나요.'), good.replace(` [ACC](${acc})`, '')])
    expect(await writtenReport({ ask: '행사 정리해서 서연한테 넘겨 문구 뽑아줘', members: [kim, seoyeon], now: NOV17, timeoutMs: 1000, write: async () => said(bad) }), bad.slice(-40)).toBe(host)
  // A hand-over from inside the time asked reads as before: its fact and its page.
  const inside = reported(part('m0', '지민', '다음 달 서울 IT 행사 일정 정리'), { facts: [{ text: 'ACC 2026이 서울에서 열려요.', url: acc, date: '12월 10일' }] })
  expect(handoffBrief('홍보 문구 3개 뽑기', '지민', inside.result!, inside.brief)).toContain(`ACC 2026이 서울에서 열려요 (12월 10일). — ${acc}`)
})

// stack-6: c6b-review.r3 finding 3, the reviewer's own input.
test('stack-6: a year that is only in the event\'s name dates its day: last year\'s event is not shown as next month\'s (c11a: structure)', async () => {
  // c11a: the teammate dates what it hands back, with the year when it is not this year, and says when nothing is there for the time asked.
  const { paths, run, named } = await company()
  await run({ add: [{ name: '지민', role: '리서치 담당' }] })
  const rule = await employeeNote(paths, (await named('지민'))!.id, NOV17, 'lookup')
  expect(rule).toContain('with the year when it is not this year')
  expect(rule).toContain('nothing_in_period: only when nothing is there for the time your part asks')
  // The reviewer's input, as data: shown as nothing for next month, with last year's day said with its year.
  const m = reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리'), { facts: [], nothing_in_period: { latest: { text: 'ACC 2025가 서울에서 열렸어요.', url: 'https://example.com/acc', date: '2025년 12월 11일' } } })
  const shown = mergedReport([m])
  expect(shown).toMatch(/^지민이 봤는데 이번엔 새로 나온 게 없어요\. 가장 최근엔 ACC 2025가 서울에서 열렸어요 \(2025년 12월 11일\)\. \[[^\]]+\]\(https:\/\/example\.com\/acc\)$/)
  // This year's event, named with its year, is next month's as before; a price is no year.
  const ok = reported(part('m1', '지민', '다음 달 서울 IT 행사 일정 정리'), { facts: [{ text: 'ACC 2026은 서울에서 열려요. 입장료는 2025원이에요.', url: 'https://example.com/acc', date: '12월 11일' }] })
  expect(mergedReport([ok])).not.toContain('새로 나온 게 없어요')
  expect(mergedReport([ok])).toContain('ACC 2026은 서울에서 열려요. 입장료는 2025원이에요 (12월 11일).')
})

// stack-6 (c6b run, C3): 지민, 서연, 도윤 each made their first search call at 11.4 s and came back with nothing read.
test('stack-6: a part handed out from chat carries search words made from its own name, so its search is run before its first round', async () => {
  const { searchWords } = await import('../src/company-tools.js')
  const now = new Date(2026, 10, 17)
  // c7 C3: "이번 주 리니어 신기능" as written found linear motors and a refrigerator. A time said relative to today is never search
  // words (it is the period the finds are checked against), a product's new features are searched as its updates, and the kind of
  // thing it is comes from the person's own ask ("경쟁사 3곳(…)": an app).
  const ask = '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜'
  expect(searchWords('이번 주 노션 신기능 조사해서 알려줘', now)).toBe('노션 새 기능 업데이트')
  expect(searchWords('이번 주 리니어 신기능 조사', now, ask)).toBe('리니어 앱 새 기능 업데이트')
  expect(searchWords('이번 주 리니어 신기능 조사해서 알려줘', now, ask)).not.toMatch(/이번\s?주/)
  expect(askedPeriod('이번 주 리니어 신기능 조사해서 알려줘', now)).toBeDefined()
  expect(searchWords('요즘 피그마 서비스 새 기능 조사', now, '요즘 피그마 서비스 새 기능 조사해줘')).toBe('피그마 서비스 새 기능 업데이트')
  expect(searchWords('최근 국내 AI 스타트업 투자 소식 조사', now)).toBe('국내 AI 스타트업 투자 소식')
  // A name is not a time word ("오늘의집"), and nothing is left to search for without the thing itself.
  expect(searchWords('오늘의집 신기능 조사', now)).toBe('오늘의집 새 기능 업데이트')
  expect(searchWords('이번 주 신기능 조사', now)).toBeUndefined()
  expect(searchWords('다음 달 서울 IT 행사 일정 정리', now)).toBe('2026년 12월 서울 IT 행사 일정')
  // What the results page's own box answers by those words keeps them.
  expect(searchWords('이번 주말 서울 날씨 찾아봐', now)).toBe('이번 주말 서울 날씨')
  // A name that was cut short, a hand-over and a name with nothing to search for give none: the teammate searches itself.
  expect(searchWords('노션(Notion)의 최근 발표 중에서 기업 고객에게 영향이 큰 변경 사항과 가격 정책 변화, 그리고 경쟁사 대비 차별점을 조사', now)).toBeUndefined()
  expect(searchWords(handoffBrief('홍보 문구 3개 뽑기', '지민', '소프트웨이브 2026이 12월 2일 열려요. https://example.com/sw', '다음 달 서울 IT 행사 일정 정리'), now)).toBeUndefined()
  expect(searchWords('조사', now)).toBeUndefined()
})

// --- grokbar cycle 7 (c7b, USER-NOTES 2026-11-17): the team as people. Results as stored by the stack-6 run (runs/stack6-50519116). ---
import stack6 from './fixtures/grokbar-stack6-team.json' with { type: 'json' }
import { updateBot } from '../src/bots.js'
import { voiceOf } from '../src/company-tools.js'
const s6 = { c3: stack6.c3.members as TeamMember[], c5: stack6.c5.members as TeamMember[], c6: stack6.c6.members as TeamMember[], h5: stack6.h5.members as TeamMember[] }
const onlyLinks = (line: string): boolean => /^\s*(?:[-*•]\s*)?(?:\[[^\]\n]+\]\([^)\n]+\)[\s·,]*)+$/.test(line)

test('c7: each teammate has a way of speaking: given on joining, three in a row differ, kept through a rename, changed by chat, never said in a reply', async () => {
  const { paths, run, named } = await company()
  const replies = [await run({ add: [{ name: '지민', role: '리서치 담당' }] }), await run(plainHire('서연도 추가해줘. 카피 담당이야')!), await run({ add: [{ name: '도윤', role: '리니어 담당', how: '변경 기록을 먼저 본다' }] })]
  const voices = await Promise.all(['지민', '서연', '도윤'].map(async name => voiceOf((await named(name))!)))
  expect(voices.every(Boolean)).toBe(true)
  expect(new Set(voices).size).toBe(3)
  // It is kept with them, beside how they work: through a rename, and through a change to how they work.
  replies.push(await run({ rename: [{ who: '지민', name: '지우' }] }), await run({ rename: [{ who: '지우', how: '뉴스를 먼저 본다' }] }))
  expect(voiceOf((await named('지우'))!)).toBe(voices[0])
  expect((await named('도윤'))!.purpose).toBe(`변경 기록을 먼저 본다\n말투: ${voices[2]}`)
  // "지우는 좀 더 차분하게 말해": the way they talk changes, how they work stays, and the reply is one line.
  const said = await run({ rename: [{ who: '지우', how: '좀 더 차분하게 말하기' }] })
  expect(said).toBe('지우한테 그렇게 전했어요.')
  expect((await named('지우'))!.purpose).toBe('뉴스를 먼저 본다\n말투: 좀 더 차분하게 말하기')
  // And the other way round: a new way of working keeps the way they were asked to talk.
  expect(await run({ rename: [{ who: '지우', how: '출처를 꼭 붙인다' }] })).toBe('지우의 일하는 방식을 바꿨어요.')
  expect((await named('지우'))!.purpose).toBe('출처를 꼭 붙인다\n말투: 좀 더 차분하게 말하기')
  // Each works in their own: the teammate is told theirs, as a way to write and never as something to mention.
  const jiu = await employeeNote(paths, (await named('지우'))!.id), seoyeon = await employeeNote(paths, (await named('서연'))!.id), doyun = await employeeNote(paths, (await named('도윤'))!.id)
  // c11a: a temperament in their own words, for their chat sentence only: no fixed ending, never "in every sentence", none for a writer's deliverable.
  expect(jiu).toContain('Your temperament: "좀 더 차분하게 말하기"')
  expect(jiu).toContain('Your role: 출처를 꼭 붙인다 Your temperament')
  expect(seoyeon).toContain(`Your temperament: ${JSON.stringify(voices[1])}`)
  expect(doyun).toContain(`Your temperament: ${JSON.stringify(voices[2])}`)
  for (const note of [jiu, seoyeon, doyun]) { expect(note).toContain('never a fixed catchphrase or ending, and never describe it'); expect(note).not.toMatch(/in every sentence|더라고요|…네요|말투:/) }
  expect(await employeeNote(paths, (await named('서연'))!.id, undefined, 'writer')).not.toMatch(/temperament|말투/)
  // Taken off and brought back with a new role, they still talk the way they did; the next one new takes a way nobody has.
  replies.push(await run({ remove: ['서연'] }), await run({ add: [{ name: '서연', role: '글 담당' }] }))
  expect(voiceOf((await named('서연'))!)).toBe(voices[1])
  // Someone on the team from before teammates had one gets theirs the first time they work, and keeps it.
  const old = await createBot(paths, { name: '하린', purpose: '디자인 담당' })
  await updateBot(paths, old.id, { label: '디자인 담당' })
  expect(voiceOf((await named('하린'))!)).toBeUndefined()
  expect(await employeeNote(paths, old.id)).toContain('Your temperament')
  const harin = (await named('하린'))!
  expect(harin.purpose).toMatch(/^디자인 담당\n말투: \S/)
  expect(await employeeNote(paths, old.id)).toContain('Your role: 디자인 담당 Your temperament')
  expect((await named('하린'))!.purpose).toBe(harin.purpose)
  // Someone added by a hand-out has one too.
  const o = await office()
  await o.assign({ wait: false, to: [{ who: '도윤', brief: '리니어 조사', topic: '리니어' }] })
  expect(voiceOf((await o.named('도윤'))!)).toBeTruthy()
  // Nothing about it is ever said: not in a reply, the status, who someone is, or what the lead is told about the team.
  const bots = await loadBots(paths)
  for (const text of [...replies, said, companyStatus(bots, []), String(aboutEmployee('지우 무슨 일 하는 사람이야?', bots, [])), await companyNote(paths, { bots, message: '지우 누구야?', chief: true })]) expect(text).not.toMatch(/말투|차분|또박또박|시원시원|담백|calm|bright|plain and brief/)
})

test('c7 C3: this run\'s stored results are one bubble of the teammates talking: no table, three name-led lines with their part and their link (c11a: structure)', async () => {
  const ctx = { now: NOV17 }
  // What the run showed: a two-column table of sentences under a report line, a link named "blank".
  expect(stack6.c3.shown).toContain('| 맡은 일 (담당) | 내용과 출처 |')
  // c11a: the same run as data. All three saw nothing this week; each hands back the newest thing it did see, with its day and page
  // (도윤's unrelated rows, motors and refrigerators, are not data).
  const notion = 'https://blank.page', slack = 'https://www.hellot.net/news/article.html?no=111811', linear = 'https://ditoday.com/channel-talk-launches-mcp-host-feature/'
  const c3 = [
    reported(s6.c3[0]!, { facts: [], nothing_in_period: { latest: { text: 'Notion 3.2 업데이트로 모바일 AI 노트 탭이 추가됐어요.', url: notion, site: 'blank', date: '1월 20일' } } }),
    reported(s6.c3[1]!, { facts: [], nothing_in_period: { latest: { text: '슬랙봇이 채널을 읽고 거래·연락처·통화 기록을 분석하는 기능이 나왔어요.', url: slack, site: '헬로티', date: '4월 2일' } } }),
    reported(s6.c3[2]!, { facts: [], nothing_in_period: { latest: { text: '채널톡이 리니어와 연동되는 MCP 호스트 기능을 냈어요.', url: linear, site: 'ditoday', date: '2025년 7월 9일' } } }),
  ]
  const said = mergedReport(c3), blocks = said.split('\n\n')
  expect(said).not.toMatch(/^\s*\|/m)
  expect(said).not.toMatch(/맡은 일|담당|조사 결과|쉬고 있/)
  // Each line says nothing is new for its own part (a line is read on its own), then the latest thing found, its day and its link.
  expect(blocks.map(block => block.split(': ')[0])).toEqual(['노션(지민)', '슬랙(서연)', '리니어(도윤)'])
  for (const block of blocks) { expect(block).toContain('이번엔 새로 나온 게 없어요.'); expect(linksIn(block), block).toHaveLength(1); expect(block).toMatch(/\]\(https?:\/\/[^)\s]+\)$/) }
  expect(blocks[2]).toContain('2025년 7월 9일')
  expect(said).not.toMatch(/냉장고|리니어모터|아이폰/)
  // A piece of the host is never a link's name, nor a cut title; the host's own naming stands, never 출처.
  expect(said).not.toMatch(/\[(?:blank|ditoday|출처)\]|\[[^\]]*(?:작성 글|…)[^\]]*\]\(/)
  expectParts(said, [['지민', notion], ['서연', slack], ['도윤', linear]])
  // BAR C3 reads the last bubble: the three products, the three names, three links.
  expect(linksIn(said)).toEqual([notion, slack, linear])
  // The writer is handed each part's latest with its day and link.
  const data = JSON.parse(reportPrompt(stack6.c3.goal, c3, undefined, ctx).split('Data: ')[1]!) as { nothing?: { latest?: { date?: string; link: string } } }[]
  // c12a B2: each day is in its text once (none of these texts states its own), never a field put in front of it again.
  expect(data.map(one => one.nothing?.latest?.text)).toEqual(['Notion 3.2 업데이트로 모바일 AI 노트 탭이 추가됐어요 (1월 20일).', '슬랙봇이 채널을 읽고 거래·연락처·통화 기록을 분석하는 기능이 나왔어요 (4월 2일).', '채널톡이 리니어와 연동되는 MCP 호스트 기능을 냈어요 (2025년 7월 9일).'])
  expect(data.map(one => one.nothing?.latest?.date)).toEqual([undefined, undefined, undefined])
  expect(data[2]!.nothing?.latest?.link).toContain(`(${linear})`)
  // The writer's text in that shape passes, its links named by the host from the data.
  const good = ['이번 주엔 셋 다 새로 낸 게 없어요.', '', `노션은 지민이 봤는데 1월 20일 모바일 AI 노트 탭이 제일 최근이에요. [노션](${notion})`, '', `슬랙은 서연이 봤는데 4월 2일 슬랙봇 업데이트가 마지막이에요. [슬랙](${slack})`, '', `리니어는 도윤이 봤는데 작년 7월 9일 채널톡 연동 소식이 제일 최근이에요. [ditoday](${linear})`].join('\n')
  const json = (message: string): string => JSON.stringify({ message, kept: [] })
  const passed = checkedReport(json(good), c3)!
  expectParts(passed, [['지민', notion], ['서연', slack], ['도윤', linear]])
  expect([...passed.matchAll(/\[([^\]]+)\]\(/g)].map(one => one[1])).toEqual(c3.map(m => m.data!.nothing!.latest!.site))
  expect(await writtenReport({ ask: stack6.c3.goal, members: c3, now: NOV17, timeoutMs: 1000, write: async () => json(good) })).toBe(passed)
  // A missing teammate, a missing latest link, a line that opens on a name and a colon, English and no JSON are refused; the host's own lines stand in.
  for (const bad of [json(good.replace(/\n\n슬랙은 .*/, '')), json(good.replace(` [슬랙](${slack})`, '')), json(good.replace('리니어는 도윤이 봤는데', '도윤: 리니어는')), json(good.replace('이번 주엔 셋 다 새로 낸 게 없어요.', 'Nothing new shipped this week at all.')), good])
    expect(await writtenReport({ ask: stack6.c3.goal, members: c3, now: NOV17, timeoutMs: 1000, write: async () => bad }), bad.slice(0, 60)).toBe(said)
  // One part still at work: its own labeled line (GROKBOT rules 7, 8), and the writer must say it.
  const waiting = [c3[0]!, c3[1]!, { ...s6.c3[2]!, state: 'working' as const, result: undefined, empty: undefined, read: undefined }]
  const early = mergedReport(waiting)
  expect(early.split('\n\n')[2]).toBe('리니어(도윤): 아직 찾는 중이에요. 끝나면 이어서 올릴게요.')
  expect(early.split('\n\n')[0]).toContain('1월 20일')
  expect(checkedReport(json(good.replace(/\n\n리니어는 .*/, '\n\n리니어는 도윤이 보고 있어요.')), waiting)).toBeUndefined()
  expect(checkedReport(json(good.replace(/\n\n리니어는 .*/, '\n\n리니어는 도윤이 아직 찾는 중이에요. 끝나면 이어서 올릴게요.')), waiting)).toBeDefined()
  // A table only when things are compared: the writer is told so; the host's own rendering has none.
  expect(reportPrompt(stack6.c3.goal, c3, undefined, ctx)).toContain('A markdown table only when three or more things are compared on the same fields')
})

test('c7 C5, C6, H5: the teammate speaks, the title is not said back, each item carries its own link, and a hand-off closes on a plain sentence (c11a: structure)', () => {
  // C5 as stored. The run showed "지민이 다음 달 서울 IT 행사 일정 정리해 왔어요." and a last line of two links named by cut titles.
  expect(stack6.c5.shown).toContain('지민이 다음 달 서울 IT 행사 일정 정리해 왔어요.')
  const coex = (s6.c5[0]!.result!.match(/https:\/\/www\.coex\.co\.kr\/\S+/) ?? [''])[0]
  // c12a B1: a plain hand-off's part is named by assign from the person's own job words (topicOf), as the run now stores it.
  const kim = reported({ ...s6.c5[0]!, topic: topicOf(s6.c5[0]!.brief), then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개 뽑기' } }, { facts: [
    { text: '소프트웨이브 2026(제11회 대한민국 소프트웨어 대전)이 코엑스에서 열려요. 무료예요.', url: coex, site: '코엑스', date: '12월 2일~4일' },
    { text: '네이버클라우드 AI Expert 공인교육이 서울 중구에서 열려요.', url: 'https://www.ncloud.com/support/edu', site: '네이버클라우드', date: '12월 중' },
  ] })
  const c5 = mergedReport([kim])
  // c11a: no "정리해 왔어요" sentence, no line of links alone. c12a B1: who and how many head the bubble, never the job's title.
  expect(c5.split('\n')[0]).toBe('지민이 서울 IT 행사 일정 2개를 찾아 왔어요.')
  expect(c5).not.toMatch(/정리해 왔어요/)
  expect(c5.split('\n').some(onlyLinks)).toBe(false)
  const items = c5.split('\n').filter(line => line.startsWith('- '))
  expect(items).toHaveLength(2)
  for (const item of items) { expect(linksIn(item), item).toHaveLength(1); expect(item).toMatch(/\]\(https?:\/\/[^)\s]+\)$/) }
  // c12a B2: the text says 코엑스 and the event but no day, so its day follows it once (C10: "12월 2일~4일 … 12월 2일부터 4일까지").
  expect(items[0]).toMatch(/^- 소프트웨이브 2026\(제11회 대한민국 소프트웨어 대전\)이 코엑스에서 열려요\. 무료예요 \(12월 2일~4일\)\. \[/)
  expect(linksIn(items[0]!)[0]).toContain('coex.co.kr')
  expect(linksIn(items[1]!)[0]).toBe('https://www.ncloud.com/support/edu')
  // BAR C5: 지민 named, 행사 and a date in the last bubble.
  expect(c5).toMatch(/지민/); expect(c5).toMatch(/행사/); expect(c5).toMatch(/12월 2일/)
  // C6 right after it: 서연's items, no "…이 찾은 내용:" label, whose find it was on the opener with its page, nothing closing it.
  expect(stack6.c6.shown).toContain('지민이 찾은 내용:')
  const lines = s6.c6[0]!.result!.split('\n').map(line => line.replace(/^\d+\.\s+/, ''))
  const park = reported(part('m2', '서연', handoffBrief('홍보 문구 3개 뽑기', '지민', kim.result!, kim.brief), { lookup: undefined, writer: true }), { items: lines })
  const c6 = mergedReport([kim, park]), rows = c6.split('\n')
  expect(c6.split('\n\n')).toHaveLength(1)
  // c12a B1: one plain sentence from data, never the to-do label "홍보 문구 3개 뽑기(서연, …):" (C6 judge: "작업 상태 보고처럼").
  expect(rows[0]).toMatch(/^서연이 지민이 찾은 서울 IT 행사 일정으로 3개 써 왔어요\. \[[^\]]+\]\(https:\/\/www\.coex\.co\.kr\//)
  expect(c6).not.toContain('뽑기')
  expect(rows.slice(1).map(line => line.slice(0, 3))).toEqual(['1. ', '2. ', '3. '])
  expect(c6).not.toMatch(/찾은 내용\s*:|다음 달 서울 IT 행사 일정 정리로/)
  expect(c6.split('\n').some(onlyLinks)).toBe(false)
  // BAR C6: three list items, 서연 named, 행사.
  expect(c6.match(/^\d+[.)]\s+\S/gm)).toHaveLength(3); expect(c6).toMatch(/서연/); expect(c6).toMatch(/소프트웨이브/)
  // H5: one bubble that names both, carries the weather's link on its opener, and has no label line.
  const weather = 'https://www.weather.go.kr/w/forecast/overall/mid-term.do?stnId1=109'
  const jimin = reported({ ...s6.h5[0]! }, { facts: [{ text: '토요일은 대체로 맑고 아침 -6~-3℃로 추워요.', url: weather, site: '기상청', date: '11월 21일' }] })
  const seoyeon = reported(part('m2', '서연', handoffBrief(s6.h5[0]!.then!.brief, '지민', jimin.result!, jimin.brief), { lookup: undefined, writer: true }), { items: [s6.h5[1]!.result!] })
  const h5 = mergedReport([jimin, seoyeon])
  expect(h5.split('\n\n')).toHaveLength(1)
  expect(h5.split('\n')[0]).toMatch(/^서연이 지민이 찾은 서울 날씨로 한 줄 써 왔어요\. \[[^\]]+\]\(https:\/\/www\.weather\.go\.kr\/[^)\s]+\)$/u)
  expect(h5.split('\n')[1]).toBe(s6.h5[1]!.result!)
  expect(h5).not.toMatch(/쓰기|찾기\(/)
  expect(h5).not.toMatch(/찾은 내용\s*:/)
  // Every bubble here is 해요체 where it is the host's own words, with no 반말 and no report wording.
  for (const text of [c5, c6, h5]) expect(text).not.toMatch(/보고|완료되었|습니다|결과예요/)
})

// stack-7: the three branches of cycle 7 met here. One rule names a link (c7a sourceName) in every team result (c7b): a site's own
// name or the plain word, never a cut title, "…", a digit note or a piece of the host, whoever put the words beside the address.
test('stack-7: a team result names every link by the one rule, also when the teammate or the writer wrote a cut title beside it (c11a: structure)', () => {
  const kim = reported(part('m1', '지민', '갤럭시 S27 가격 조사', { topic: '갤럭시 S27' }), { facts: [{ text: '갤럭시 S27은 전작 S26 출고가 115만 5천 원 선으로 예상돼요.', url: 'https://blog.naver.com/a/1', site: '출시일 사생활 보호 화면 S....' }] })
  const lee = reported(part('m2', '서연', '픽셀 11 가격 조사', { topic: '픽셀 11' }), { facts: [{ text: '픽셀 11은 999유로부터예요.', url: 'https://ko.vidabytes.com/pixel-11', site: 'vidabytes' }] })
  const park = reported(part('m3', '도윤', '서울 날씨 조사', { topic: '서울 날씨' }), { facts: [{ text: '서울 날씨는 토요일 맑고 12도예요.', url: 'https://www.weather.go.kr/w/index.do', site: '기상청 날씨누리' }] })
  const said = mergedReport([kim, lee, park])
  const names = [...said.matchAll(/\[([^\]]+)\]\(/g)].map(found => found[1])
  // A cut title and a piece of the host give way to the host's own naming (c11a R2: the whole host, never 출처); a site the host knows
  // keeps the host's name for it. c9a R2: a blog post is named by its platform.
  expect(names).toEqual(['네이버 블로그', 'ko.vidabytes.com', '기상청'])
  expect(said).not.toMatch(/…|\.{3,}\]|\[vidabytes\]|\[blank\]|\[출처\]/)
  // The writer's own words for a link never stand: the host names it again by the same rule.
  const written = JSON.stringify({ message: '셋 다 찾아봤어요.\n\n갤럭시 S27은 지민이 봤는데 전작 기준 115만 5천 원 선이래요. [출시일 사생활 보호 화면 S....](https://blog.naver.com/a/1)\n\n픽셀 11은 서연이 봤는데 999유로부터예요. [vidabytes](https://ko.vidabytes.com/pixel-11)\n\n서울 날씨는 도윤이 봤는데 토요일 맑고 12도예요. [weather](https://www.weather.go.kr/w/index.do)', kept: ['f1', 'f2', 'f3'] })
  expect([...checkedReport(written, [kim, lee, park])!.matchAll(/\[([^\]]+)\]\(/g)].map(found => found[1])).toEqual(names)
  // Each teammate is named in the line's own words: a link's name ("[슬랙](…)") does not stand in for who found it.
  const slack = reported(part('m1', '지민', '슬랙 신기능 조사', { topic: '슬랙' }), { facts: [{ text: '슬랙이 허들 요약을 냈어요.', url: 'https://slack.com/blog/huddles' }] }), notion = reported(part('m2', '서연', '노션 신기능 조사', { topic: '노션' }), { facts: [{ text: '노션이 AI 회의록을 냈어요.', url: 'https://notion.so/a' }] })
  expect(checkedReport(JSON.stringify({ message: '둘 다 찾아봤어요.\n\n허들 요약이 나왔어요. [슬랙](https://slack.com/blog/huddles)\n\n노션이 AI 회의록을 냈어요. [노션](https://notion.so/a)', kept: ['f1', 'f2'] }), [slack, notion])).toBeUndefined()
})

// stack-7 (c7b run, C6 and H5 replayed through the merged host lines): "지민이 찾아보니 확인해 보니 다음 달 …".
test('stack-7, c9 fix 2: a hand-off says once, on its opener, whose find it was made from; no closing sentence (c11a: structure)', () => {
  for (const [text, url] of [['다음 달 서울 IT 행사로 소프트웨이브 2026이 있어요.', 'https://www.coex.co.kr/sw'], ['토요일은 맑고 낮 기온 2~6℃예요.', 'https://www.weather.go.kr/w/a'], ['토요일 서울은 맑고 20도예요.', 'https://www.weather.go.kr/w/a']] as const) {
    const kim = reported(part('m1', '지민', '서울 조사', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '문구 쓰기' } }), { facts: [{ text, url }] })
    const park = reported(part('m2', '서연', handoffBrief('문구 쓰기', '지민', kim.result!, kim.brief), { background: true, lookup: undefined, writer: true }), { items: ['가볍게 나가 봐요.'] })
    // c9: the closing sentence is gone; the page it carried is on the opener, whose find it was is said once, and nobody is said to have looked.
    const shown = mergedReport([kim, park]), lines = shown.split('\n')
    // c12a: one item is that line on its own (as the writer may write it).
    expect(lines.at(-1)).toBe('가볍게 나가 봐요.')
    expect(lines[0]).toContain(`](${url})`)
    // c12a B1: whose find, named by the giver's part in the person's words ("서울 조사" → "서울로").
    expect(lines[0]).toContain('지민이 찾은 서울로')
    expect(shown.match(/지민/g)).toHaveLength(1)
    expect(shown).not.toMatch(/찾아보니|확인해 보니|찾은 걸 따랐어요/u)
  }
})

// stack-7: c7b gives a teammate a way of speaking (employeeNote), c7a makes a price always carry a figure (LOOKUP_RULE). A named
// teammate on a lookup gets both in one prompt (team-runner: memberPersona + employeeNote), and neither sentence cancels the other;
// the anonymous helpers of R1 / R2 / T1 (no botId) get the lookup rule alone and still answer in short values.
test('stack-7: a named teammate on a lookup keeps both their way of speaking and the lookup rule; an anonymous helper gets no way of speaking (c11a: structure)', async () => {
  const { paths, run, named } = await company()
  await run({ add: [{ name: '지민', role: '리서치 담당' }] })
  const kim = (await named('지민'))!
  const member = part('m1', '지민', '갤럭시 S27 가격이랑 출시일 조사', { botId: kim.id })
  const persona = memberPersona(member) + await employeeNote(paths, kim.id, undefined, 'lookup')
  // Both rules are there, whole.
  expect(persona).toContain(LOOKUP_RULE)
  expect(persona).toContain('A price point always carries a figure with its currency')
  expect(persona).toContain('Your temperament:')
  // c11a: the lookup rule's value lines go into the report block whole, after the rule that asks for them.
  expect(persona.indexOf('Everything the rules above say to report goes into facts')).toBeGreaterThan(persona.indexOf(LOOKUP_RULE))
  // The temperament is for their own chat sentence only: it does not touch figures, lines or links, and is never a fixed ending.
  expect(persona).toContain('Speak naturally in it in your own chat sentence ("note"); never a fixed catchphrase or ending')
  expect(persona).not.toMatch(/in every sentence|더라고요/)
  // A helper the lead hired by role (R1, R2, T1): the lookup rule and nothing about a way of speaking or a chat message.
  const helper = memberPersona(part('m2', 'galaxyS27', '갤럭시 S27의 가격과 출시일 조사', { botId: undefined }))
  expect(helper).toContain(LOOKUP_RULE)
  expect(helper).not.toMatch(/way of speaking|temperament|Answer as yourself/)
})
import { LOOKUP_RULE, memberPersona } from '../src/team-hire-tools.js'

// c9 fix 5 (C10, USER-NOTES): "…나눠 맡겼어요." → "지민한테 맡겼어요." → "…넘겼어요." read as a run of status lines.
test('c9 fix 5: a later hand-off in one thread is said another way, each one sentence that names who has it, never 보고', async () => {
  const said = async (o: Awaited<ReturnType<typeof office>>, args: Record<string, unknown>): Promise<string> => {
    const line = String(await o.assign(args))
    expect(Array.from(line).length, line).toBeLessThanOrEqual(60)
    expect(line).not.toMatch(/보고/u)
    await appendBotTurn(o.paths, o.chief.id, { role: 'assistant', text: line, at: new Date().toISOString() })
    return line
  }
  const o = await office()
  expect(await said(o, { wait: false, to: [{ who: '지민', brief: '다음 달 서울 IT 행사 일정 정리' }] })).toBe('지민한테 맡겼어요.')
  expect(await said(o, { wait: false, to: [{ who: '서연', brief: '홍보 문구 3개 써줘' }] })).toBe('서연한테 넘겨 놨어요.')
  expect(await said(o, { wait: false, to: [{ who: '지민', brief: '부산 맛집 목록 정리' }] })).toBe('지민이 바로 볼 거예요.')
  // A split after a split; a hand-off with a then after one.
  const p = await office()
  expect(await said(p, { wait: false, to: [{ who: '지민', brief: '노션 신기능 조사' }, { who: '서연', brief: '슬랙 신기능 조사' }] })).toBe('지민, 서연한테 나눠 맡겼어요.')
  expect(await said(p, { wait: false, to: [{ who: '지민', brief: '피그마 신기능 조사' }, { who: '서연', brief: '지라 신기능 조사' }] })).toBe('지민, 서연한테 하나씩 넘겨 놨어요.')
  expect(await said(p, { wait: false, to: [{ who: '지민', brief: '이번 주말 서울 날씨 찾기', then: { who: '서연', brief: '문구 한 줄 써줘' } }] })).toBe('지민한테 맡기고, 끝나면 서연한테 넘길게요.')
  expect(await said(p, { wait: false, to: [{ who: '지민', brief: '이번 주말 부산 날씨 찾기', then: { who: '서연', brief: '문구 한 줄 써줘' } }] })).toBe('지민이 먼저 하고 서연이 이어서 할 거예요.')
})

test('c9b r2: assign stores each teammate\'s own voice on their part and on the one their work is handed to', async () => {
  const { voiceOf } = await import('../src/company-tools.js')
  const o = await office()
  await o.assign({ wait: false, to: [{ who: '지민', brief: '다음 달 서울 IT 행사 일정 정리', then: { who: '서연', brief: '홍보 문구 3개 뽑기' } }] })
  const kim = (await o.named('지민'))!, park = (await o.named('서연'))!
  expect(voiceOf(kim)).toBeTruthy()
  expect(voiceOf(park)).not.toBe(voiceOf(kim))
  const m = o.task.team!.members[0]!
  expect(m.voice).toBe(voiceOf(kim))
  expect(m.then?.voice).toBe(voiceOf(park))
})
