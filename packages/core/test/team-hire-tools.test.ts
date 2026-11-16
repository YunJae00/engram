import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createTask, listTasks, parseAsk, updateTask, type DelegatedTask, type VaultPaths } from '../src/index.js'
import { TEAM_LEAD_RULE } from '../src/agent-voice.js'
import { AUTO_REVIEW, skipWalls, cutShortAnswer, failOnRestart, memberPersona, memberTask, settleMember, withoutExtras, teamHireTools, teamNote, teamReviewIssue, teamTree, teamUnverified, TEAM_TOKEN_RESERVE, type MemberRedo, type TeamHost } from '../src/team-hire-tools.js'

const three = [{ role: '서울 조사', brief: 'Seoul weather', deliverable: 'summary' }, { role: '제주 조사', brief: 'Jeju weather', deliverable: 'summary' }, { role: '부산 조사', brief: 'Busan weather', deliverable: 'summary' }]

function world(goal = '서울·제주·부산 날씨 조사해서 PDF로') {
  const task: DelegatedTask = { id: 't1', goal, botId: 'b1', state: 'running', turns: 1, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z', approvals: [], log: [] }
  const state = { task, tokens: 200_000, said: goal, runs: [] as { id: string; redo?: MemberRedo }[], released: [] as string[], answer: (id: string) => `result of ${id}`, asks: new Set<string>(), gate: undefined as Promise<void> | undefined, steer: undefined as Promise<void> | undefined, live: new Set<string>() }
  const host = (self: string | null): TeamHost => ({
    self,
    load: async () => structuredClone(state.task),
    change: async work => work(state.task),
    run: async (ids, _signal, redo) => {
      for (const id of ids) state.live.add(id)
      await state.gate
      for (const id of ids) { state.live.delete(id); state.runs.push({ id, ...(redo ? { redo } : {}) }); const m = state.task.team!.members.find(one => one.id === id)!; if (state.asks.delete(id)) { m.state = 'waiting'; m.result = state.answer(id) } else if (m.lookup) settleMember(m, { answer: state.answer(id) }, 'now'); else { m.state = 'done'; m.result = state.answer(id) } }
    },
    release: async ids => { for (const id of ids) { state.released.push(id); state.task.team!.members.find(one => one.id === id)!.state = 'released' } },
    live: id => state.live.has(id),
    tokensLeft: async () => state.tokens,
    personSaid: () => state.said,
    ...(state.steer ? { steered: () => state.steer! } : {}),
  })
  const call = (self: string | null, name: string, args: Record<string, unknown> = {}) => teamHireTools(host(self)).find(tool => tool.name === name)!.run(args, { task: '' })
  return { state, call, tools: (self: string | null) => teamHireTools(host(self)) }
}

describe('team hire tools', () => {
  it('tells the lead not to hire for a simple ask; a task without a team needs no team check', () => {
    expect(TEAM_LEAD_RULE).toContain('never hire')
    expect(TEAM_LEAD_RULE).toContain('prefer 1 to 3 members')
    const { state } = world()
    expect(state.task.team).toBeUndefined()
    expect(teamUnverified(state.task)).toBe(false)
  })

  it('hires three members, runs them and returns each result', async () => {
    const { state, call } = world()
    const out = JSON.parse(await call(null, 'hire_members', { members: three, notes: 'Use Celsius' }))
    expect(out.members.map((m: { id: string; state: string; result: string }) => [m.id, m.state, m.result])).toEqual([['m1', 'done', 'result of m1'], ['m2', 'done', 'result of m2'], ['m3', 'done', 'result of m3']])
    expect(out.hiresLeft).toBe(5)
    expect(state.task.team!.members[0]).toMatchObject({ parentId: null, depth: 1, sessionKey: 'team-t1-m1' })
    expect(state.task.team!.members[0]!.brief).toContain('Notes from the lead:\nUse Celsius')
    expect(teamUnverified(state.task)).toBe(true)
    expect(teamReviewIssue(state.task)).toContain('서울 조사 (m1)')
  })

  // perf146: the Busan member's brief said "가능하면 미세먼지"; it chased air quality for 90 s after the weather and the lead waited.
  it('cuts optional extras the person did not ask for out of a brief, and keeps a lookup flag', async () => {
    expect(withoutExtras('부산 오늘 날씨를 조사해 주세요. 가능하면 미세먼지도 알려 주세요.', '부산 날씨 조사해줘')).toBe('부산 오늘 날씨를 조사해 주세요.')
    expect(withoutExtras('Busan weather today, and if possible the air quality', 'Busan weather')).toBe('Busan weather today')
    expect(withoutExtras('부산 날씨. 가능하면 미세먼지도.', '부산 날씨랑 가능하면 미세먼지도')).toBe('부산 날씨. 가능하면 미세먼지도.')
    expect(withoutExtras('가능하면 미세먼지', '부산 날씨')).toBe('가능하면 미세먼지')
    const { state, call } = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    await call(null, 'hire_members', { members: [{ role: '부산 조사', brief: '부산 오늘 날씨 조사. 가능하면 미세먼지도 조사.', deliverable: '기온과 하늘 상태 (가능하면 미세먼지)', lookup: true }, { role: '정리', brief: '표로 정리' }] })
    expect(state.task.team!.members[0]).toMatchObject({ brief: '부산 오늘 날씨 조사.', deliverable: '기온과 하늘 상태', lookup: true })
    expect(state.task.team!.members[1]!.lookup).toBeUndefined()
    expect(memberPersona(state.task.team!.members[0]!)).toContain('You only look things up')
    expect(memberPersona(state.task.team!.members[1]!)).not.toContain('You only look things up')
    expect(TEAM_LEAD_RULE).toContain('asks for bots, members or a team, hire them')
    expect(TEAM_LEAD_RULE).toContain('at most 3 short lines')
  })

  // grokbar: three review_member rounds cost ~10 s of a 71 s answer; a sourced lookup needs none, and then no team check turn either.
  it('accepts a lookup member that finished on its own with a source; any other member keeps the review', async () => {
    const m = { id: 'm1', parentId: null, depth: 1, role: 'r', brief: 'b', lookup: true as const, state: 'working' as const, sessionKey: 'k', hiredAt: '' }
    const settled = (outcome: Parameters<typeof settleMember>[1], patch: Record<string, unknown> = {}) => { const one = { ...m, ...patch } as Parameters<typeof settleMember>[0]; settleMember(one, outcome, 'now', true); return one }
    expect(settled({ answer: '서울 12도 맑음 (https://weather.example/seoul)' }).review).toEqual({ ok: true, note: AUTO_REVIEW })
    expect(settled({ answer: '서울 12도 맑음' }).review).toBeUndefined()
    expect(settled({ answer: '서울 12도 (https://weather.example/seoul)', timedOut: true }).review).toBeUndefined()
    expect(settled({ answer: '서울 12도 (https://weather.example/seoul)', budgetExhausted: true }).review).toBeUndefined()
    expect(settled({ answer: '어느 도시인가요? https://weather.example', asked: true }).review).toBeUndefined()
    expect(settled({ answer: '', error: 'it was stopped.' }).review).toBeUndefined()
    expect(settled({ answer: '정리했어요 https://weather.example\n/tmp/out/weather.xlsx' }).review).toBeUndefined()
    expect(settled({ answer: '서울 12도 (https://weather.example/seoul)' }, { lookup: undefined }).review).toBeUndefined()

    const { state, call } = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    state.answer = id => id === 'm3' ? '부산 15도' : `${id} 12도 (https://weather.example/${id})`
    const out = JSON.parse(await call(null, 'hire_members', { members: three.map(one => ({ ...one, lookup: true })) }))
    expect(out.members.map((one: { id: string; state: string; accepted?: boolean }) => [one.id, one.state, one.accepted])).toEqual([['m1', 'released', true], ['m2', 'released', true], ['m3', 'done', undefined]])
    expect(out.note).toContain('do not call review_member for them')
    expect(out.note).toContain('For the others: Review each member')
    expect(state.released).toEqual(['m1', 'm2'])
    expect(teamReviewIssue(state.task)).toBe('Team members not reviewed yet: 부산 조사 (m3). Call review_member for each before reporting done.')
    await call(null, 'review_member', { id: 'm3', ok: true, note: 'fine' })
    expect(teamReviewIssue(state.task)).toBe('')

    const all = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    all.state.answer = id => `${id} 12도 (https://weather.example/${id})`
    const sourced = JSON.parse(await all.call(null, 'hire_members', { members: three.map(one => ({ ...one, lookup: true })) }))
    expect(sourced.note).not.toContain('Review each member')
    expect(teamReviewIssue(all.state.task)).toBe('')
  })

  // grokbar T1: "아 대구도 추가해" said while the lead waits on three members belongs in the same answer.
  it('returns early when the person speaks while the lead waits, and the next call hands back the members left working', async () => {
    const { state, tools } = world('봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘')
    state.answer = id => `${id} 12도 (https://weather.example/${id})`
    let finish!: () => void, speak!: () => void
    state.gate = new Promise(resolve => { finish = resolve })
    state.steer = new Promise(resolve => { speak = resolve })
    const lead = tools(null), hire = lead.find(tool => tool.name === 'hire_members')!
    const first = hire.run({ members: three.map(one => ({ ...one, lookup: true })) }, { task: '' })
    await new Promise(resolve => setTimeout(resolve, 5))
    speak()
    const early = JSON.parse(await first)
    expect(early.members.map((one: { id: string; state: string }) => [one.id, one.state])).toEqual([['m1', 'working'], ['m2', 'working'], ['m3', 'working']])
    expect(early.note).toContain('The person wrote to you while the team worked')
    // The added part is hired; the same call waits for the three still working and returns all four.
    state.steer = new Promise(() => undefined)
    const second = hire.run({ members: [{ role: '대구 조사', brief: 'Daegu weather', lookup: true }] }, { task: '' })
    await new Promise(resolve => setTimeout(resolve, 5))
    finish()
    const out = JSON.parse(await second)
    expect(out.members.map((one: { id: string; state: string }) => [one.id, one.state])).toEqual([['m1', 'released'], ['m2', 'released'], ['m3', 'released'], ['m4', 'released']])
    expect(teamReviewIssue(state.task)).toBe('')
    // Nothing left open: an empty call is refused as before.
    await expect(hire.run({ members: [] }, { task: '' })).rejects.toThrow('members needs 1 to 4 entries')
  })

  it('waits for the members left working when called with no new members; a member cannot be steered', async () => {
    const { state, tools } = world('서울 부산 제주 날씨')
    let finish!: () => void, speak!: () => void
    state.gate = new Promise(resolve => { finish = resolve })
    state.steer = new Promise(resolve => { speak = resolve })
    const hire = tools(null).find(tool => tool.name === 'hire_members')!
    const first = hire.run({ members: three }, { task: '' })
    await new Promise(resolve => setTimeout(resolve, 5))
    speak()
    expect(JSON.parse(await first).members.every((one: { state: string }) => one.state === 'working')).toBe(true)
    state.steer = new Promise(() => undefined)
    const wait = hire.run({ members: [] }, { task: '' })
    finish()
    expect(JSON.parse(await wait).members.map((one: { id: string; state: string }) => [one.id, one.state])).toEqual([['m1', 'done'], ['m2', 'done'], ['m3', 'done']])
    expect(state.task.team!.hires).toBe(3)
  })

  it('counts a time-boxed member\'s partial result as delivered, not failed', () => {
    const m = { id: 'm1', parentId: null, depth: 1, role: 'r', brief: 'b', state: 'working' as const, sessionKey: 'k', hiredAt: '' }
    const partial = { ...m }, empty = { ...m }, broken = { ...m }
    settleMember(partial, { answer: '부산 15도', timedOut: true }, 'now')
    expect(partial).toMatchObject({ state: 'done', result: '부산 15도\n(stopped at its time or call limit: this is what it had)' })
    // perf146 r2: a member that timed out with nothing delivered nothing: failed, and its note is one the thread never shows ("Failed: ").
    settleMember(empty, { answer: '', timedOut: true }, 'now')
    expect(empty).toMatchObject({ state: 'failed', result: 'Failed: it ran out of time before it reported anything.' })
    const korean = { ...m }
    settleMember(korean, { answer: '부산 15도', timedOut: true }, 'now', true)
    expect(korean).toMatchObject({ state: 'done', result: '부산 15도\n(시간 한도에서 멈춤: 여기까지 찾은 내용)' })
    expect((korean as { result?: string }).result).not.toMatch(/[A-Za-z]{4,}/)
    // perf146 r3: a member stopped while it was still announcing its first step delivered nothing.
    for (const line of ['지금 검색하겠습니다.', '서울 날씨를 찾아볼게요', 'Let me search for the Seoul weather.']) {
      const announced = { ...m }
      settleMember(announced, { answer: line, timedOut: true }, 'now', true)
      expect(announced).toMatchObject({ state: 'failed', result: 'Failed: it ran out of time before it reported anything.' })
    }
    const full = { ...m }
    settleMember(full, { answer: '지금 검색하겠습니다.\n서울 12도 (https://weather.example)', timedOut: true }, 'now', true)
    expect(full.state).toBe('done')
    settleMember(broken, { answer: '', error: 'it was stopped.' }, 'now')
    expect(broken.state).toBe('failed')
    expect(cutShortAnswer('Not verified as complete.\n\nThe tool-call or time limit was reached.\n\nUnverified response:\n부산 15도')).toBe('부산 15도')
    expect(cutShortAnswer('부산 15도')).toBe('부산 15도')
  })

  it('lets a member hire a helper at depth 2 and 3, and refuses a depth-3 member', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [three[0]] })
    await call('m1', 'hire_members', { members: [{ role: 'helper', brief: 'part' }] })
    await call('m2', 'hire_members', { members: [{ role: 'deep', brief: 'part' }] })
    expect(state.task.team!.members.map(m => [m.id, m.parentId, m.depth])).toEqual([['m1', null, 1], ['m2', 'm1', 2], ['m3', 'm2', 3]])
    expect(await call('m3', 'hire_members', { members: [{ role: 'too deep', brief: 'part' }] })).toBe('Depth limit: a depth-3 member cannot hire. Do this part yourself.')
    expect(state.task.team!.members).toHaveLength(3)
  })

  it('enforces the hire budget, also for calls that arrive together', async () => {
    const { state, call } = world()
    const two = { members: [three[0], three[1]] }
    const outs = await Promise.all([call(null, 'hire_members', two), call(null, 'hire_members', two), call(null, 'hire_members', two), call(null, 'hire_members', two), call(null, 'hire_members', two)])
    expect(outs.filter(out => out.startsWith('Hire budget:'))).toHaveLength(1)
    expect(state.task.team!.hires).toBe(8)
    expect(await call(null, 'hire_members', { members: [three[2]] })).toBe('Hire budget: 8 of 8 used, 0 left. Hire at most 0 or do the work yourself.')
    expect(state.task.team!.members).toHaveLength(8)
  })

  it('refuses to hire when the token budget is nearly used', async () => {
    const { state, call } = world()
    state.tokens = TEAM_TOKEN_RESERVE - 1
    expect(await call(null, 'hire_members', { members: three })).toContain('token budget is nearly used')
    expect(state.task.team).toBeUndefined()
  })

  it('review ok=false re-runs a member once with the note, then releases it; ok=true releases', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [three[0], three[1]] })
    const redo = JSON.parse(await call(null, 'review_member', { id: 'm1', ok: false, note: 'Add the humidity' }))
    expect(state.runs.at(-1)).toEqual({ id: 'm1', redo: { note: 'Add the humidity', answered: false } })
    expect(memberTask(state.task.team!.members[0]!, state.task.goal, state.runs.at(-1)!.redo)).toContain('Your lead reviewed this and asks for a redo:\nAdd the humidity')
    expect(redo.state).toBe('released')
    expect(state.task.team!.hires).toBe(3)
    expect(JSON.parse(await call(null, 'review_member', { id: 'm2', ok: true, note: 'good' }))).toEqual({ id: 'm2', state: 'released' })
    expect(state.task.team!.members[1]!.review).toEqual({ ok: true, note: 'good' })
    expect(state.released).toEqual(['m1', 'm2'])
    expect(teamReviewIssue(state.task)).toBe('')
  })

  it('does not run a second redo: the member is released with its last result', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [three[0]] })
    state.task.team!.members[0]!.review = { ok: false, note: 'first' }
    const runs = state.runs.length
    expect(await call(null, 'review_member', { id: 'm1', ok: false, note: 'again' })).toContain('already redone once')
    expect(state.runs).toHaveLength(runs)
    expect(state.task.team!.members[0]!.state).toBe('released')
    expect(await call(null, 'review_member', { id: 'm1', ok: true, note: '' })).toContain('released')
    expect(await call('m1', 'review_member', { id: 'm1', ok: true, note: '' })).toBe('No member "m1" hired by you.')
  })

  it('hands a member question up with the role named and passes the answer back', async () => {
    const { state, call } = world()
    state.asks.add('m1'); state.answer = () => '이 메일 보내도 될까?'
    // The question is raised in the lead's thread by the tool itself (an ask ends the lead's turn), not left to another call.
    expect(parseAsk(await call(null, 'hire_members', { members: [{ role: '조사팀', brief: 'mail' }] }))?.question).toBe('조사팀: 이 메일 보내도 될까?')
    expect(state.task.team!.members[0]!.state).toBe('waiting')
    state.answer = () => 'sent'
    expect(JSON.parse(await call(null, 'review_member', { id: 'm1', ok: false, note: '보내도 돼' })).state).toBe('done')
    expect(state.runs.at(-1)!.redo).toEqual({ note: '보내도 돼', answered: true })
  })

  // perf146 r2: one member's sign-in question was the lead's whole answer while two cities had been reported.
  it('returns what the others delivered when one member needs the person, instead of ending on the question alone', async () => {
    const { state, call } = world()
    state.asks.add('m1'); state.answer = id => id === 'm1' ? '어느 계정으로 볼까?' : `${id} 15도`
    const raw = await call(null, 'hire_members', { members: [three[0], three[1], three[2]] })
    expect(parseAsk(raw)).toBeNull()
    const out = JSON.parse(raw)
    expect(out.members.map((m: { state: string }) => m.state)).toEqual(['waiting', 'done', 'done'])
    expect(out.members[0].ask).toBe('서울 조사: 어느 계정으로 볼까?')
    expect(out.note).toContain('give the person the combined answer')
    expect(out.note).toContain('close with the waiting member')
  })

  it('a lookup member skips a source that needs the person instead of asking about it; its own ask_person still asks', async () => {
    const ask = 'ASK: {"question":"열린 페이지에서 로그인이나 확인을 마치고 다 되면 알려줘.","options":[]}'
    const tool = (name: string, runRich = false) => ({ name, description: '', argsSchema: {}, run: async () => ask, ...(runRich ? { runRich: async () => ({ text: ask }) } : {}) })
    const skipped = await skipWalls(tool('open_page')).run({ url: 'https://search.example/?q=서울' }, { task: '' })
    expect(parseAsk(skipped)).toBeNull()
    expect(skipped).toContain('https://search.example/?q=서울 needs the person')
    expect(skipped).toContain('do not try to get past it')
    expect((await skipWalls(tool('open_page', true)).runRich!({}, { task: '' })).text).toContain('was not read')
    expect(await skipWalls({ ...tool('read_pages'), run: async () => 'page text' }).run({}, { task: '' })).toBe('page text')
    expect(parseAsk(await skipWalls(tool('ask_person')).run({}, { task: '' }))?.question).toContain('로그인')
  })

  it('asks every waiting member in one question; a member that asks again after the answer is asked again', async () => {
    const { state, call } = world()
    state.asks.add('m1'); state.asks.add('m2'); state.answer = id => `${id} question?`
    expect(parseAsk(await call(null, 'hire_members', { members: [three[0], three[1]] }))?.question).toBe('서울 조사: m1 question?\n제주 조사: m2 question?')
    state.asks.add('m1'); state.answer = () => 'one more?'
    expect(parseAsk(await call(null, 'review_member', { id: 'm1', ok: false, note: 'answer' }))?.question).toBe('서울 조사: one more?')
    expect(teamNote(state.task.team)).toContain('제주 조사 (m2) asked the person: m2 question?')
    expect(teamNote(state.task.team)).toContain('review_member({id:"m2", ok:false, note:<the answer>})')
  })

  it('a member released without any review still counts as unreviewed; a resumed member sees its open helpers', () => {
    const { state } = world()
    const base = { parentId: null, depth: 1, brief: 'b', hiredAt: state.task.createdAt }
    state.task.team = { members: [{ ...base, id: 'm1', role: 'r1', state: 'released', sessionKey: 'k1' }, { ...base, id: 'm2', role: 'r2', state: 'released', sessionKey: 'k2', review: { ok: true, note: '' } }], hires: 2, maxHires: 8, maxDepth: 3, big: false }
    expect(teamReviewIssue(state.task)).toBe('Team members not reviewed yet: r1 (m1). Call review_member for each before reporting done.')
    const helper = { ...base, id: 'm3', parentId: 'm1', depth: 2, role: 'helper', state: 'done' as const, sessionKey: 'k3', result: 'helper found it' }
    expect(memberTask(state.task.team.members[0]!, 'goal', { note: 'yes', answered: true }, [helper])).toContain('- helper (m3) [done]: helper found it')
  })

  it('shows a big plan first: a coding job is gated without the big flag, and a yes from the same turn does not approve it', async () => {
    const { state, call } = world('Yes')
    state.task.goal = 'Build a small todo app project'
    const coder = { members: [{ role: 'builder', brief: 'write the code' }] }
    expect(await call(null, 'hire_members', coder)).toContain('Big team plan: nothing was hired')
    expect(await call(null, 'hire_members', coder)).toContain('Big team plan: nothing was hired')
    expect(state.task.team).toMatchObject({ members: [], hires: 0, big: true })
    expect(state.task.team!.approvedAt).toBeUndefined()
    state.task.turns = 2; state.said = '고칠 점 말할게'
    expect(await call(null, 'hire_members', coder)).toContain('Big team plan')
    state.task.turns = 3; state.said = '이대로 진행'
    expect(JSON.parse(await call(null, 'hire_members', coder)).members).toHaveLength(1)
    expect(state.task.team!.approvedAt).toBeTruthy()
  })

  it('gates more than three members and the big flag the same way', async () => {
    const many = world(), flagged = world()
    expect(await many.call(null, 'hire_members', { members: [...three, { role: 'PDF', brief: 'make the pdf' }] })).toContain('Big team plan')
    expect(await flagged.call(null, 'hire_members', { members: [three[0]], big: true })).toContain('Big team plan')
    expect(many.state.runs).toHaveLength(0)
  })

  it('team_status lists the tree', async () => {
    const { state, call } = world()
    expect(await call(null, 'team_status')).toBe('No team on this task.')
    await call(null, 'hire_members', { members: [three[0]] })
    await call('m1', 'hire_members', { members: [{ role: 'helper', brief: 'part' }] })
    expect(await call(null, 'team_status')).toBe('- 서울 조사 (m1) [done] — result of m1\n  - helper (m2) [done] — result of m2\nhires 2/8')
    expect(teamTree(state.task.team)).toContain('hires 2/8')
  })

  it('marks members that were working as failed after a restart', async () => {
    const { state, call } = world()
    await call(null, 'hire_members', { members: [three[0], three[1]] })
    state.task.team!.members[0]!.state = 'working'
    expect(failOnRestart(state.task.team!, '2026-11-14T01:00:00.000Z')).toEqual(['m1'])
    expect(state.task.team!.members[0]).toMatchObject({ state: 'failed', result: 'Failed: the app restarted while this member was working.' })
  })

  it('persists the team on the task, loads old tasks unchanged and rejects a bad team', async () => {
    const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
    await mkdir(temporary, { recursive: true })
    const root = await mkdtemp(join(temporary, 'engram-team-core-')), paths = { cache: join(root, '.engram') } as unknown as VaultPaths
    const old = await createTask(paths, 'old task', 'b1')
    const task = await createTask(paths, 'team task', 'b1')
    const { state, call } = world()
    await call(null, 'hire_members', { members: three })
    await updateTask(paths, task.id, t => { t.team = structuredClone(state.task.team!) })
    const loaded = await listTasks(paths)
    expect(loaded.find(t => t.id === task.id)!.team).toEqual(state.task.team)
    expect(loaded.find(t => t.id === old.id)!.team).toBeUndefined()
    const file = join(paths.cache, 'tasks.json'), raw = JSON.parse(await readFile(file, 'utf8'))
    raw.tasks[1].team.members[0].depth = 4
    await writeFile(file, JSON.stringify(raw))
    await expect(listTasks(paths)).rejects.toThrow('Invalid saved tasks; the file was preserved.')
  })
})
