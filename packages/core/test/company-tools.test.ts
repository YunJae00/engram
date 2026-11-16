import { expect, test, vi } from 'vitest'
import { loadBotMemory, recordFacts } from '../src/bot-memory.js'
import { appendBotTurn, createBot, loadArchivedBots, loadBots, readBotTranscript } from '../src/bots.js'
import { companyNote, companyStatus, companyStatusTool, isAssignAsk, isCompanyAsk, isDutyAsk, isOutsideAsk, plainHandoff, isStatusAsk, isTeamWorkAsk, staffTool, takesCompanyLane, teamRecord, TEAM_MEMORY } from '../src/company-tools.js'
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
  expect(companyStatus(await loadBots(paths), []).split('\n')).toEqual(['- 지민 (리서치 담당) — 쉬는 중', '- 서연 (카피 담당) — 쉬는 중'])
})

test('removing archives (memory and transcript kept, restorable) and a rename keeps id, memory and role', async () => {
  const { paths, run, named } = await company()
  await run({ add: [{ name: '지민', role: '리서치 담당', how: '조사한다' }, { name: '서연', role: '카피 담당' }] })
  const kim = (await named('지민'))!, park = (await named('서연'))!
  await recordFacts(paths, kim.id, ['2026-11-16: 노션 신기능 조사를 마쳤다'])
  await recordFacts(paths, park.id, ['2026-11-16: 홍보 문구 3개를 썼다'])
  await appendBotTurn(paths, park.id, { role: 'assistant', text: '문구 3개입니다', at: new Date().toISOString() })

  expect(await run({ remove: ['서연'], rename: [{ who: '지민', name: '지우' }] })).toBe('서연을 뺐어요. 기록은 남겨 뒀으니 다시 부르면 돌아와요.\n지민은 이제 지우예요.')
  expect(await named('서연')).toBeUndefined()
  expect(await named('지민')).toBeUndefined()
  expect(await named('지우')).toMatchObject({ id: kim.id, label: '리서치 담당', purpose: '조사한다' })
  expect((await loadBotMemory(paths, kim.id)).facts.map(fact => fact.text).join()).toContain('노션')
  expect((await loadArchivedBots(paths)).map(bot => bot.id)).toEqual([park.id])
  expect((await loadBotMemory(paths, park.id)).facts).toHaveLength(1)
  expect(await readBotTranscript(paths, park.id)).toHaveLength(1)

  // Adding someone under a removed name is refused with the way back; the way back restores the same agent.
  expect(await run({ add: [{ name: '서연', role: '카피 담당' }] })).toBe('서연은 전에 뺀 팀원이에요. "서연 다시 불러와"라고 하면 돌아와요.')
  expect(await run({ restore: ['서연'] })).toBe('서연이 돌아왔어요.')
  expect(await named('서연')).toMatchObject({ id: park.id, label: '카피 담당' })
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
  expect(companyStatus(bots, tasks, bot => bot === id('지민') ? 'search_web: 서울 IT 행사' : undefined).split('\n')).toEqual([
    '- 지민 (리서치 담당) — 일하는 중: 다음 달 서울 IT 행사 일정 정리 · search_web: 서울 IT 행사',
    '- 서연 (카피 담당) — 쉬는 중 · 마지막 일: 홍보 문구 3개',
    '- 도윤 (영업 담당) — 일하는 중: 리니어 신기능 조사',
    '- 하린 (디자인 담당) — 답을 기다리는 중: 로고 시안',
  ])
  const tool = companyStatusTool(paths)
  expect(tool.closes).toBe(true)
  expect(await tool.run({}, { task: '' })).toContain('- 지민 (리서치 담당) — 쉬는 중')
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
  expect(note).toContain(now)
  expect(note).toContain(old)
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
    '도윤은 리니어 담당으로 새로 추가했어요.', '지민, 서연, 도윤 결과예요.', '', '| 맡은 일 (담당) | 내용과 출처 |', '|---|---|',
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
  expect(await o.assign({ wait: false, to: [{ who: '지민', brief: '조사', then: { who: '서연', brief: '홍보 문구 3개' } }] })).toBe('지민한테 맡겼어요. 끝나면 서연한테 넘길게요.')
  expect(o.task.team!.members[1]!.then).toEqual({ botId: (await o.named('서연'))!.id, who: '서연', brief: '홍보 문구 3개' })
})

test('a failed part is said as failed, and an agent who needs the person is asked up', async () => {
  const failing = await office(member => member.role === '서연' ? { answer: '', error: 'no source' } : { answer: `${member.role} 결과` })
  const out = await failing.assign({ wait: true, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }] })
  // The missing part is said in its own row, never dropped and never the host's own failure note.
  expect(out.split('\n').slice(-2)).toEqual(['| 지민 | 지민 결과 |', '| 서연 | 조사하지 못했어요. |'])
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
  expect(await o.assign(hand)).toBe('지민 일이 끝나면 서연한테 넘길게요.')
  expect(o.attached).toHaveLength(2)
  expect(o.task.team).toBeUndefined()
  // Finished earlier (in a task on record): 서연 starts now with that result.
  o.attachable(false)
  const { createTask, updateTask } = await import('../src/delegated-tasks.js')
  const earlier = await createTask(o.paths, '행사 조사', o.chief.id)
  const kim = (await o.named('지민'))!
  await updateTask(o.paths, earlier.id, t => { t.state = 'done'; t.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '행사', botId: kim.id, state: 'released', result: '11월 20일 서울 AI 서밋 https://example.com/summit', sessionKey: 's', hiredAt: '2026-11-16T00:00:00.000Z', finishedAt: '2026-11-16T00:01:00.000Z' }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
  // grokbar B7 (C6): the report is 서연's own result, then the facts it was made from, under whose they were and what that job was.
  expect(await o.assign(hand)).toBe('서연 결과예요. 지민한테 받은 내용으로 했어요.\n\n서연 결과 https://example.com/m1\n\n지민한테 받은 내용 (행사):\n11월 20일 서울 AI 서밋 https://example.com/summit')
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
    '지민, 서연, 도윤 결과예요.', '', '| 맡은 일 (담당) | 내용과 출처 |', '|---|---|',
    '| 노션 (지민) | Notion Agent 업그레이드 (11/12) · 새 모델 라우터 · [notion.com](https://www.notion.com/releases) |',
    '| 슬랙 (서연) | Salesforce 스워밍 도입 / 채널 자동 생성 · (여기까지만 찾았어요) · [slack.com](https://slack.com/blog/news) · [slack.com](https://slack.com/intl/ko-kr/whats-new) |',
    '| 리니어 (도윤) | 조사하지 못했어요. |',
  ])
  // One table and nothing an internal note or a tool would say.
  expect(report.match(/^\|---/gm)).toHaveLength(1)
  expect(report).not.toMatch(/Failed|ran out of time/)
  // Codex cap (b7 r3): the host's limit note for a result cut short was shown in the row as written.
  expect(report).not.toMatch(/한도|멈춤|stopped at/)
})

test('one agent\'s result stands as they wrote it, and a handoff keeps the facts it was made from', () => {
  expect(mergedReport([part('m1', '지민', '행사', { result: '12월 2일 소프트웨이브\nhttps://example.com/a' })])).toBe('지민 결과예요.\n\n12월 2일 소프트웨이브\nhttps://example.com/a')
  // Nothing written out as an address: the page they read is added as a link.
  expect(mergedReport([part('m1', '지민', '행사', { result: '12월 2일 소프트웨이브', sources: ['https://example.com/a'] })])).toBe('지민 결과예요.\n\n12월 2일 소프트웨이브\n\n출처: [example.com](https://example.com/a)')
  // C6 as it ran: 지민 worked first, his result went on to 서연 (TeamMember.then), and the task holds both.
  const kim = part('m1', '지민', '다음 달 서울 IT 행사 일정 정리', { background: true, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개' }, result: '소프트웨이브 2026: 12월 2일~4일, 코엑스 https://example.com/sw' })
  const park = part('m2', '서연', handoffBrief('홍보 문구 3개', '지민', kim.result!, kim.brief), { background: true, result: '1. 12월, 코엑스에서 만나요\n2. 참가비 무료\n3. 지금 사전등록' })
  const task = { id: 't', goal: 'g', botId: 'chief', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [], team: { members: [kim, park], hires: 2, maxHires: 8, maxDepth: 3, big: false } } as DelegatedTask
  expect(employeesReport(task)).toBe([
    '서연 결과예요. 지민한테 받은 내용으로 했어요.', '', '1. 12월, 코엑스에서 만나요', '2. 참가비 무료', '3. 지금 사전등록', '',
    '지민한테 받은 내용 (다음 달 서울 IT 행사 일정 정리):', '소프트웨이브 2026: 12월 2일~4일, 코엑스 https://example.com/sw',
  ].join('\n'))
  // The first one failed, so nothing was handed on: his own part says so.
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'failed', result: 'Failed: it was stopped.' }] } })).toBe('지민 결과예요.\n\n지민: 조사하지 못했어요.')
  // Someone who needs the person, or a file handed in, is the lead's to report.
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, state: 'waiting' }] } })).toBeUndefined()
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, files: ['a.xlsx'] }] } })).toBeUndefined()
  expect(employeesReport({ ...task, team: { ...task.team!, members: [{ ...kim, background: undefined }] } })).toBeUndefined()
  expect(employeesReport(undefined)).toBeUndefined()
})

test('adding one named agent with one duty is the agents call itself', async () => {
  expect(plainHire('지민 하나 추가해줘. 리서치 담당이야')).toEqual({ add: [{ name: '지민', role: '리서치 담당' }] })
  expect(plainHire('서연도 추가해줘. 카피 담당이야')).toEqual({ add: [{ name: '서연', role: '카피 담당' }] })
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
  expect(aboutEmployee('지민 무슨 일 하는 사람이야?', bots, [o.task])).toBe('지민은 리서치 담당이에요. 자료를 찾아 출처와 함께 정리한다\n지금은 쉬고 있어요. 최근에 한 일:\n- 노션 이번 주 신기능 조사\n- 다음 달 서울 IT 행사 일정 정리')
  expect(aboutEmployee('서연은 누구야?', bots, [o.task])).toBe('서연은 카피 담당이에요.\n아직 맡은 일은 없어요.')
  // Anything more than that one question, two agents, or nobody on the team: the model's turn.
  for (const ask of ['지민이랑 서연 뭐 해?', '지민 무슨 일 하는 사람인지 표로 정리해줘', '하린 누구야?', '지민한테 행사 조사 시켜', '다들 뭐하고 있어?'])
    expect(aboutEmployee(ask, bots, [o.task]), ask).toBeUndefined()
})
