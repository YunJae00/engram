import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { continuationPrompt, createTask, listTasks, parseAsk, updateTask, type AgentTool, type DelegatedTask, type Engine, type TaskTeam, type TeamMember, type ToolSessionJob, type VaultPaths } from 'core'
import { cards, done, readback, setup } from './task-runner-fixture.js'
import { memberLane, teamRunner, WRITER_HARD_MS, type TurnKit } from '../src/main/team-runner.js'
import { withLease, WorkerPool } from '../src/main/worker-pool.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Turn = { tools: AgentTool[]; prompt: string; signal: AbortSignal; session: string; role: string; usage(tokens: number): void }
const reply = (answer: string) => ({ answer, steps: [], fellBack: false })
const use = (tools: AgentTool[], name: string, args: Record<string, unknown> = {}) => tools.find(tool => tool.name === name)!.run(args, { task: '' })
const member = (id: string, state: TeamMember['state'], more: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role: `role ${id}`, brief: 'part', state, sessionKey: `team-x-${id}`, hiredAt: new Date().toISOString(), ...more })
const teamOf = (...members: TeamMember[]): TaskTeam => ({ members, hires: members.length, maxHires: 8, maxDepth: 3, big: false })
const three = { members: [{ role: 'seoul', brief: 'Seoul weather' }, { role: 'jeju', brief: 'Jeju weather' }, { role: 'busan', brief: 'Busan weather' }] }

async function world(base: number, script: (turn: Turn) => Promise<string | { answer: string; asked: true }>, more: { reportCapMs?: number } = {}) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'engram-team-')), paths = { cache: join(root, '.engram') } as unknown as VaultPaths
  const pool = new WorkerPool({ base, sample: async () => ({ freePct: 60, swapGrowthBytes: 0, cpuBusyPct: 10 }), log: () => undefined })
  const created = await createTask(paths, 'Research the weather in Seoul, Jeju and Busan', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const closed: string[] = [], seen: Turn[] = [], ended: string[] = [], busy = new Set<string>()
  const peak = { running: 0, working: 0, top: 0 }
  const run: Run = async (deps, prompt, options = {}) => {
    const lease = await pool.lease(options.signal)
    if (!lease) throw new Error('aborted')
    peak.running = Math.max(peak.running, pool.running)
    const turn = { tools: deps.tools, prompt, signal: options.signal!, session: options.session!, role: /"(.+?)"/.exec(options.persona ?? '')?.[1] ?? '', usage: (tokens: number) => options.onUsage?.(tokens) }
    seen.push(turn)
    try {
      const out = await withLease(lease, async () => {
        peak.top = Math.max(peak.top, ++peak.working)
        try { return await script(turn) } finally { peak.working-- }
      })
      return typeof out === 'string' ? reply(out) : { ...reply(out.answer), asked: true }
    } finally { lease.end() }
  }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: key => closed.push(key), endLane: lane => ended.push(lane), step: () => undefined, changed: () => undefined, busy: channel => busy.has(channel), run, ...more })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), { name: 'app_click', description: '', argsSchema: {}, run: async () => 'clicked' }, { name: 'new_bot', description: '', argsSchema: {}, run: async () => '' }] }
  // The lead's turn holds a pool slot, as a real turn's tools do.
  const lead = async (name: string, args: Record<string, unknown> = {}) => {
    const lease = (await pool.lease())!
    try { return await withLease(lease, () => use(team.tools('bot-b1', kit), name, args)) } finally { expect(lease.held).toBe(true); lease.end() }
  }
  const task = async () => (await listTasks(paths)).find(t => t.id === created.id)!
  const members = async () => (await task()).team!.members
  return { paths, pool, team, kit, lead, task, members, closed, seen, ended, peak, busy, id: created.id }
}

describe('team runner', () => {
  // perf146 r2: under load the pool target fell to 1 and three lookup members ran one after another (35 s + 45 s + the third never started).
  it('runs the lookup members of one hire side by side in the lead\'s slot even when the pool target is 1', async () => {
    const w = await world(1, async turn => { await new Promise(resolve => setTimeout(resolve, 20)); return `${turn.role} is sunny` })
    const out = JSON.parse(await w.lead('hire_members', { members: three.members.map(m => ({ ...m, lookup: true })) }))
    // c6: every settled lookup member is accepted and released by the host.
    expect(out.members.map((m: { state: string }) => m.state)).toEqual(['released', 'released', 'released'])
    expect(w.peak.top).toBe(3)
    expect(w.peak.running).toBe(1)
    expect(w.pool.running).toBe(0)
  })

  it('runs three hired members concurrently up to the pool target and returns their results', async () => {
    const w = await world(2, async turn => { await new Promise(resolve => setTimeout(resolve, 20)); return `${turn.role} is sunny, saved report.pdf` })
    const out = JSON.parse(await w.lead('hire_members', three))
    expect(out.members.map((m: { state: string; result: string }) => [m.state, m.result])).toEqual([['done', 'seoul is sunny, saved report.pdf'], ['done', 'jeju is sunny, saved report.pdf'], ['done', 'busan is sunny, saved report.pdf']])
    expect(out.members[0].files).toEqual(['report.pdf'])
    expect(w.peak.top).toBe(2)
    expect(w.peak.running).toBeLessThanOrEqual(2)
    expect(w.seen.map(turn => turn.session)).toEqual([`team-${w.id}-m1`, `team-${w.id}-m2`, `team-${w.id}-m3`])
    expect(w.seen[0]!.prompt).toContain('Seoul weather')
    expect(w.seen[0]!.tools.map(tool => tool.name)).not.toContain('new_bot')
    expect(w.ended).toContain(memberLane('bot-b1', 'm1'))
    expect(w.pool.running).toBe(0)
  })

  it('does not deadlock with one slot: a waiting parent gives its slot back, three levels deep', async () => {
    const w = await world(1, async turn => {
      if (turn.role === 'seoul') {
        const hired = JSON.parse(await use(turn.tools, 'hire_members', { members: [{ role: 'helper', brief: 'sub part' }] }))
        await use(turn.tools, 'review_member', { id: hired.members[0].id, ok: true, note: 'fine' })
        return `seoul with ${hired.members[0].result}`
      }
      if (turn.role === 'helper') {
        const hired = JSON.parse(await use(turn.tools, 'hire_members', { members: [{ role: 'deep', brief: 'deep part' }] }))
        await use(turn.tools, 'review_member', { id: hired.members[0].id, ok: true, note: 'fine' })
        return `helper with ${hired.members[0].result}`
      }
      if (turn.role === 'deep') return `deep refused: ${await use(turn.tools, 'hire_members', { members: [{ role: 'deeper', brief: 'x' }] })}`
      return 'unused'
    })
    const out = JSON.parse(await w.lead('hire_members', { members: [three.members[0]] }))
    expect(out.members[0].result).toBe('seoul with helper with deep refused: Depth limit: a depth-3 member cannot hire. Do this part yourself.')
    expect(w.peak.running).toBe(1)
    expect((await w.members()).map(m => [m.id, m.parentId, m.depth, m.state])).toEqual([['m1', null, 1, 'done'], ['m2', 'm1', 2, 'released'], ['m3', 'm2', 3, 'released']])
    expect((await w.members())[1]!.review).toEqual({ ok: true, note: 'fine' })
    expect(await w.lead('team_status')).toContain('  - helper (m2) [released]')
  })

  it('a member that reports without reviewing its helper is reminded once, then fails', async () => {
    const prompts: string[] = []
    const w = await world(1, async turn => {
      if (turn.role !== 'seoul') return 'helper result'
      prompts.push(turn.prompt)
      if (prompts.length === 1) await use(turn.tools, 'hire_members', { members: [{ role: 'helper', brief: 'sub part' }] })
      return 'seoul done without review'
    })
    const out = JSON.parse(await w.lead('hire_members', { members: [three.members[0]] }))
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('You reported without reviewing the helpers you hired: helper (m2)')
    expect(out.members[0]).toMatchObject({ state: 'failed', result: 'Failed: it reported without reviewing helper.\n\nNot reviewed by seoul (check before you accept): helper: helper result' })
    expect((await w.members())[1]).toMatchObject({ state: 'released' })
    expect((await w.members())[1]!.review).toEqual({ ok: false, note: 'Not reviewed: seoul ended before reviewing it (Failed: it reported without reviewing helper.).' })
  })

  it('a member that asks the person keeps its helper; after the answer it reviews that helper, and the lead got the question by itself', async () => {
    const prompts: string[] = []
    const w = await world(1, async turn => {
      if (turn.role === 'helper') return 'helper result'
      prompts.push(turn.prompt)
      if (prompts.length === 1) { await use(turn.tools, 'hire_members', { members: [{ role: 'helper', brief: 'sub part' }] }); return { answer: 'Which city first?', asked: true } }
      return `${await use(turn.tools, 'review_member', { id: 'm2', ok: true, note: 'fine' })} seoul done`
    })
    expect(parseAsk(await w.lead('hire_members', { members: [three.members[0]] }))?.question).toBe('seoul: Which city first?')
    expect((await w.members()).map(m => [m.id, m.state])).toEqual([['m1', 'waiting'], ['m2', 'done']])
    expect(w.closed).not.toContain(`team-${w.id}-m2`)
    const resumed = JSON.parse(await w.lead('review_member', { id: 'm1', ok: false, note: 'Busan' }))
    expect(prompts[1]).toContain('The person answered your question:\nBusan')
    expect(prompts[1]).toContain('- helper (m2) [done]: helper result')
    expect(resumed).toMatchObject({ id: 'm1', state: 'done', result: '{"id":"m2","state":"released"} seoul done' })
    expect((await w.members())[1]).toMatchObject({ state: 'released', review: { ok: true, note: 'fine' } })
  })

  it("members' tokens count against the lead's own turn budget and are saved once, with the lead's turn", async () => {
    let leadSaw = 0
    const w = await world(1, async turn => { turn.usage(30_000); return 'ok' })
    const engine = w.team.leadEngine('bot-b1', { id: 'claude', runTools: async () => { await w.lead('hire_members', { members: [three.members[0]] }); return { text: 'done' } } } as unknown as Engine)
    await engine.runTools!({ onUsage: (tokens: number) => { leadSaw += tokens } } as unknown as ToolSessionJob)
    expect(leadSaw).toBe(30_000)
    expect((await w.task()).tokensUsed ?? 0).toBe(0)
    expect(w.team.leadEngine('bot-b1~team-m1', engine)).toBe(engine)
    // With no lead session to charge, a member's tokens are saved on the task directly.
    await w.lead('hire_members', { members: [three.members[1]] })
    expect((await w.task()).tokensUsed).toBe(30_000)
  })

  it('a failing member does not take its siblings down', async () => {
    const w = await world(2, async turn => { if (turn.role === 'jeju') throw new Error('page would not load'); return 'ok' })
    const out = JSON.parse(await w.lead('hire_members', three))
    expect(out.members.map((m: { state: string }) => m.state)).toEqual(['done', 'failed', 'done'])
    expect(out.members[1].result).toBe('Failed: page would not load')
  })

  it('review ok=false re-runs the member once with the note; accepted members are released and their sessions closed', async () => {
    const w = await world(1, async turn => turn.prompt.includes('Add humidity') ? 'second try' : 'first try')
    await w.lead('hire_members', { members: [three.members[0], three.members[1]] })
    const redo = JSON.parse(await w.lead('review_member', { id: 'm1', ok: false, note: 'Add humidity' }))
    expect(redo).toMatchObject({ state: 'released', result: 'second try' })
    expect(w.seen.at(-1)!.prompt).toContain('Your previous result:\nfirst try')
    expect(JSON.parse(await w.lead('review_member', { id: 'm2', ok: true, note: 'good' }))).toEqual({ id: 'm2', state: 'released' })
    expect(w.closed).toEqual(expect.arrayContaining([`team-${w.id}-m1`, `team-${w.id}-m2`]))
    expect((await w.members()).map(m => m.state)).toEqual(['released', 'released'])
    expect((await w.task()).team!.hires).toBe(3)
  })

  it('stop aborts and releases every descendant, and a late result does not overwrite released', async () => {
    const signals: AbortSignal[] = []
    const w = await world(2, async turn => {
      signals.push(turn.signal)
      if (turn.role === 'seoul') return use(turn.tools, 'hire_members', { members: [{ role: 'helper', brief: 'sub part' }] })
      await new Promise<void>(resolve => turn.signal.addEventListener('abort', () => resolve(), { once: true }))
      return 'late result'
    })
    const hiring = w.lead('hire_members', { members: [three.members[0]] })
    await vi.waitFor(() => expect(signals).toHaveLength(2), { timeout: 5000 })
    await w.team.stop('bot-b1')
    await hiring
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect((await w.members()).map(m => m.state)).toEqual(['released', 'released'])
    expect((await w.members())[1]!.result).toBeUndefined()
    expect(w.closed).toEqual(expect.arrayContaining([`team-${w.id}-m1`, `team-${w.id}-m2`]))
    expect(w.pool.running).toBe(0)
  })

  it('restart marks working members failed, closes their sessions and tells the lead; the team survives reload', async () => {
    const w = await world(1, async () => 'ok')
    await updateTask(w.paths, w.id, t => { t.state = 'waiting'; t.team = teamOf(member('m1', 'working'), member('m2', 'waiting'), member('m3', 'done', { result: 'kept' })) })
    await w.team.resume()
    const members = await w.members()
    expect(members.map(m => m.state)).toEqual(['failed', 'failed', 'done'])
    expect(members[0]!.result).toBe('Failed: the app restarted while this member was working.')
    expect(w.closed).toEqual(['team-x-m1', 'team-x-m2', 'team-x-m3'])
    expect(w.team.note('bot-b1')).toContain('re-hire them with hire_members or finish with what exists')
    expect(w.team.note('bot-b1')).toContain('role m3 (m3) [done] — kept')
  })

  it('releases members of a task that ended and fails members whose lead turn ended', async () => {
    const w = await world(1, async () => 'ok')
    await updateTask(w.paths, w.id, t => { t.team = teamOf(member('m1', 'working'), member('m2', 'done')) })
    await w.team.turnEnded('bot-b1')
    expect((await w.members()).map(m => m.state)).toEqual(['failed', 'done'])
    await updateTask(w.paths, w.id, t => { t.state = 'stopped' })
    await w.team.turnEnded('bot-b1')
    expect((await w.members()).map(m => m.state)).toEqual(['released', 'released'])
  })

  it('only one member uses the screen at a time', async () => {
    const tries: string[] = []
    let free!: () => void
    const held = new Promise<void>(resolve => { free = resolve })
    const w = await world(2, async turn => {
      if (turn.role === 'seoul') { tries.push(await use(turn.tools, 'app_click')); await held; return 'ok' }
      await vi.waitFor(() => expect(tries).toHaveLength(1))
      try { tries.push(await use(turn.tools, 'app_click')) } catch (error) { tries.push((error as Error).message) } finally { free() }
      return 'ok'
    })
    await w.lead('hire_members', { members: [three.members[0], three.members[1]] })
    expect(tries).toEqual(['clicked', 'seoul is using the screen. Do the parts that need no screen, or report that the screen was busy.'])
  })

  it('reports waiting while its members run, so the 45 s tool clock is paused', async () => {
    let during = false
    const w = await world(1, async () => { during = w.team.waiting('bot-b1'); return 'ok' })
    await w.lead('hire_members', { members: [three.members[0]] })
    expect(during).toBe(true)
    expect(w.team.waiting('bot-b1')).toBe(false)
  })
})

describe('agents on the team handed work from the person\'s thread (assign)', () => {
  const staffed = async (script: Parameters<typeof world>[1], more: Parameters<typeof world>[2] = {}) => {
    const w = await world(2, script, more)
    const { createBot } = await import('core'), { updateBot } = await import('../../../packages/core/src/bots.js')
    await createBot(w.paths, { name: '엔그램' })
    const kim = await updateBot(w.paths, (await createBot(w.paths, { name: '지민', purpose: '자료를 찾아 출처와 함께 정리한다' })).id, { label: '리서치 담당' })
    const park = await updateBot(w.paths, (await createBot(w.paths, { name: '서연', purpose: '홍보 문구를 쓴다' })).id, { label: '카피 담당' })
    const reported: string[] = []
    w.team.reportTo((channel, taskId) => reported.push(`${channel} ${taskId}`))
    const assign = (args: Record<string, unknown>) => use(w.team.tools('bot-b1', w.kit, () => undefined), 'assign', args)
    return { ...w, kim, park, reported, assign }
  }
  const personas: string[] = []
  const persona: Run = async (_deps, _prompt, options = {}) => { personas.push(options.persona ?? ''); return reply('노션이 AI 회의록을 냈다 https://notion.so/releases') }

  it('only the person\'s own thread has assign, and a member never does', async () => {
    const w = await staffed(async () => 'ok')
    expect(w.team.tools('bot-b1', w.kit).map(tool => tool.name)).not.toContain('assign')
    expect(w.team.tools('bot-b1', w.kit, () => undefined).map(tool => tool.name)).toContain('assign')
    expect(w.team.tools(memberLane('bot-b1', 'm1'), w.kit, () => undefined).map(tool => tool.name)).not.toContain('assign')
  })

  it('an agent works as themselves and the finished job goes on their own record', async () => {
    const w = await staffed(async turn => `${turn.role}: 노션이 AI 회의록을 냈다 https://notion.so/releases`)
    const { loadBotMemory, readBotTranscript, recordFacts } = await import('core')
    await recordFacts(w.paths, w.kim.id, ['지난주에 슬랙 가격을 조사했다'])
    // grokbar B7: a waited lookup comes back as the answer itself, under the agent's name, with no merge round.
    expect(await w.assign({ wait: true, to: [{ who: '지민', brief: '노션 신기능 조사' }] })).toBe('지민: 노션 신기능은 이래요.\n\n지민: 노션이 AI 회의록을 냈다. [노션](https://notion.so/releases)')
    expect((await readBotTranscript(w.paths, w.kim.id)).map(turn => [turn.role, turn.text])).toEqual([['user', '노션 신기능 조사'], ['assistant', '지민: 노션이 AI 회의록을 냈다 https://notion.so/releases']])
    expect((await loadBotMemory(w.paths, w.kim.id)).facts.at(-1)!.text).toMatch(/^노션 신기능 조사 → 지민: 노션이 AI 회의록을 냈다 .* \(지민, \d{4}-\d\d-\d\d\)$/)
    expect((await w.members())[0]).toMatchObject({ botId: w.kim.id, lookup: true, state: 'released', review: { ok: true } })
    // The persona carries who they are, their role and what they remember.
    const p = await staffed(async () => 'unused')
    await recordFacts(p.paths, p.kim.id, ['지난주에 슬랙 가격을 조사했다'])
    const team = teamRunner({ paths: p.paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run: persona })
    await use(team.tools('bot-b1', p.kit, () => undefined), 'assign', { wait: true, to: [{ who: '지민', brief: '노션 신기능 조사' }] })
    expect(personas[0]).toContain('You are "지민", a member of a hidden team')
    expect(personas[0]).toContain('You are 지민, 리서치 담당')
    expect(personas[0]).toContain('자료를 찾아 출처와 함께 정리한다')
    expect(personas[0]).toContain('지난주에 슬랙 가격을 조사했다')
    // c7: they answer as themselves, in their own way of speaking (given when they were added), never as a memo.
    expect(personas[0]).toContain('Answer as yourself, the way you would message a colleague')
    expect(personas[0]).toContain('Your way of speaking, in every sentence you write: calm and exact')
    expect(personas[0]).not.toContain('말투:')
  })

  it('hands a finished result to the next agent, and only when the first ended done', async () => {
    const w = await staffed(async turn => turn.role === '지민' ? '11월 20일 서울 AI 서밋 https://example.com/summit' : `문구 3개 <- ${turn.prompt.includes('11월 20일 서울 AI 서밋 https://example.com/summit') ? '지민 자료' : '자료 없음'}`)
    // grokbar B7 (C6): one report, 서연's result. c9 fix 2: whose find it was made from is a clause and a link on her opener, with no closing sentence.
    expect(await w.assign({ wait: true, to: [{ who: '지민', brief: '행사 조사', then: { who: '서연', brief: '홍보 문구 3개' } }] })).toBe('서연: 지민이 찾은 행사로 세 개 만들어 봤어요. [출처](https://example.com/summit)\n\n문구 3개 <- 지민 자료')
    // grokbar C6: the next one's job is writing from what was handed over, so they run as a writer: no tools at all, the handed result in the prompt.
    expect((await w.members())[1]).toMatchObject({ writer: true, title: '홍보 문구 3개' })
    expect((await w.members())[1]!.lookup).toBeUndefined()
    expect(w.seen[1]!.tools).toEqual([])
    expect(w.seen[1]!.prompt).toContain('Handed over by 지민')
    expect((await w.members()).map(m => [m.role, m.state])).toEqual([['지민', 'released'], ['서연', 'released']])
    expect((await w.members())[1]).toMatchObject({ botId: w.park.id, role: '서연', state: 'released' })
    expect(w.seen.map(turn => turn.role)).toEqual(['지민', '서연'])
    expect((await w.task()).team!.hires).toBe(2)
    const failed = await staffed(async turn => { if (turn.role === '지민') throw new Error('no source'); return 'never' })
    expect(await failed.assign({ wait: true, to: [{ who: '지민', brief: '행사 조사', then: { who: '서연', brief: '홍보 문구 3개' } }] })).toBe('지민이 행사를 아직 못 찾아서, 서연한테는 못 넘겼어요.')
    // grokbar C10: a part that found nothing leaves its line on the team's record too, in plain words.
    const { loadBotMemory } = await import('core')
    await vi.waitFor(async () => expect((await loadBotMemory(failed.paths, '_team')).facts.map(fact => fact.text.replace(/\d{4}-\d\d-\d\d/, 'day'))).toEqual(['행사 조사 → 못 찾았어요 (지민, day)']))
    expect(failed.seen.map(turn => turn.role)).toEqual(['지민'])
  })

  // c9 fix 4 (H5): "지민이는 이번 주말 서울 날씨 찾아보고, 서연이는 그걸로 … 써줘". The thread got only 서연's bubble, closed by "…기상청에서 나온 거예요".
  it('c9: a hand-off nobody waits on shows the first teammate\'s own bubble when they hand on, then the second\'s alone; a stop between leaves only the first', async () => {
    const { employeesReport, handoffShown } = await import('core')
    for (const stopped of [false, true]) {
      let go!: () => void
      const gate = new Promise<void>(resolve => { go = resolve })
      const w = await staffed(async turn => {
        if (turn.role === '지민') return '이번 주말 서울은 토요일 아침 영하 6도, 낮 2~6도에 대체로 맑대요. https://www.weather.go.kr/w/a'
        await new Promise<void>((resolve, reject) => { void gate.then(resolve); turn.signal.addEventListener('abort', () => reject(new Error('aborted'))) })
        return '맑은 주말, 낮 2~6도면 짧은 한강 산책이 딱이에요!'
      })
      expect(await w.assign({ wait: false, to: [{ who: '지민', brief: '이번 주말 서울 날씨 찾기', then: { who: '서연', brief: '주말 나들이 추천 문구 한 줄 써줘' } }] })).toBe('지민한테 맡기고, 끝나면 서연한테 넘길게요.')
      // 지민 handed on: the lead is told at once, and that report is 지민's own find, alone, with its link.
      await vi.waitFor(() => expect(w.reported).toHaveLength(1))
      const first = employeesReport(await w.task())!
      expect(first).toBe('지민: 이번 주말 서울은 토요일 아침 영하 6도, 낮 2~6도에 대체로 맑대요. [기상청](https://www.weather.go.kr/w/a)')
      await updateTask(w.paths, w.id, handoffShown)
      if (stopped) {
        await w.team.stop('bot-b1')
        await updateTask(w.paths, w.id, t => { t.state = 'stopped' })
        go()
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(w.reported).toHaveLength(1)
        continue
      }
      go()
      await vi.waitFor(() => expect(w.reported).toHaveLength(2))
      // The second bubble is 서연's alone: it names 지민 and the weather, carries the page, and nothing closes it. Two bubbles after the ack.
      const second = employeesReport(await w.task())!
      expect(second).toBe('서연: 지민이 찾은 이번 주말 서울 날씨로 이렇게 써 봤어요. [기상청](https://www.weather.go.kr/w/a)\n\n맑은 주말, 낮 2~6도면 짧은 한강 산책이 딱이에요!')
      expect(second).not.toContain('지민: ')
    }
  })

  it('a background agent outlives the lead\'s turn, takes a handoff given meanwhile, and the lead is told once when all have ended', async () => {
    let go!: () => void
    const gate = new Promise<void>(resolve => { go = resolve })
    const w = await staffed(async turn => { if (turn.role === '지민') { turn.usage(1000); await gate; return '행사 3건 https://example.com/events' } return `문구 3개 <- ${turn.prompt.includes('행사 3건') ? '지민 자료' : '없음'}` })
    expect(await w.assign({ wait: false, to: [{ who: '지민', brief: '다음 달 서울 IT 행사 일정 정리' }] })).toBe('지민한테 맡겼어요.')
    await vi.waitFor(async () => expect((await w.members())[0]!.state).toBe('working'))
    // The lead's turn ends: the task waits for the report, and the member is not counted as lost.
    await updateTask(w.paths, w.id, t => { t.state = 'waiting' })
    await w.team.turnEnded('bot-b1')
    expect((await w.members())[0]).toMatchObject({ state: 'working', background: true })
    expect(w.team.waiting('bot-b1')).toBe(false)
    // "지민 조사 끝나면 서연한테 넘겨": asked in a new turn (a new task) while 지민 is still on it.
    const second = await createTask(w.paths, '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', 'b1')
    await updateTask(w.paths, second.id, t => { t.state = 'running'; t.turns = 1 })
    expect(await w.assign({ wait: true, to: [{ who: '지민', then: { who: '서연', brief: '홍보 문구 3개' } }] })).toBe('지민이 끝내면 서연한테 넘길게요.')
    await updateTask(w.paths, second.id, t => { t.state = 'done' })
    expect(w.reported).toEqual([])
    go()
    // c9 fix 4: told when 지민 hands on (his own bubble), and once more when all have ended (서연's).
    await vi.waitFor(() => expect(w.reported).toEqual([`bot-b1 ${w.id}`, `bot-b1 ${w.id}`]))
    expect((await w.members()).map(m => [m.role, m.state, m.background, m.result])).toEqual([['지민', 'done', true, '행사 3건 https://example.com/events'], ['서연', 'done', true, '문구 3개 <- 지민 자료']])
    // Its tokens are saved with the task, not left hanging in flight.
    expect((await w.task()).tokensUsed).toBe(1000)
    expect(continuationPrompt(await w.task(), 'report')).toContain('- 서연 [done]: 문구 3개 <- 지민 자료')
  })

  it('an agent mid-turn in their own conversation gets the job on their record after that turn, and the lead is not kept waiting', async () => {
    const w = await staffed(async () => '노션 결과 https://notion.so/releases')
    const { appendBotTurn, readBotTranscript } = await import('core')
    const texts = async () => (await readBotTranscript(w.paths, w.kim.id)).map(turn => turn.text)
    w.busy.add(`bot-${w.kim.id}`)
    await appendBotTurn(w.paths, w.kim.id, { role: 'user', text: '내 질문', at: new Date().toISOString() })
    expect(await w.assign({ wait: true, to: [{ who: '지민', brief: '노션 신기능 조사' }] })).toContain('지민: 노션 신기능은 이래요.')
    expect(await texts()).toEqual(['내 질문'])
    await appendBotTurn(w.paths, w.kim.id, { role: 'assistant', text: '내 답', at: new Date().toISOString() })
    w.busy.delete(`bot-${w.kim.id}`)
    await vi.waitFor(async () => expect(await texts()).toEqual(['내 질문', '내 답', '노션 신기능 조사', '노션 결과 https://notion.so/releases']), { timeout: 3000 })
  })

  // grokbar C6 (stack2): 서연 wrote her three lines without calling a tool, was stopped at the limit, and they were thrown away ("조사하지 못했어요").
  it('a writer stopped at the limit keeps what they wrote; with nothing written they found nothing; and the hand-off goes on the record', async () => {
    const { loadBotMemory } = await import('core')
    // The runner itself: a writer member is time-boxed (WRITER_HARD_MS) and its draft is its result.
    expect(WRITER_HARD_MS).toBeLessThanOrEqual(20_000)
    const w = await staffed(async () => 'unused')
    let calls = 0
    const run: Run = (deps, prompt, options = {}) => ++calls === 1 ? Promise.resolve(reply('Notion Agent 개선 https://www.notion.com/releases'))
      : new Promise((_resolve, reject) => { options.onStart?.(); expect(deps.tools).toEqual([]); expect(prompt).toContain('Notion Agent 개선'); expect(options.persona).toContain('you have no tools'); options.onToken?.('1. 일은 에이전트에게\n2. 하루를 맡기세요\n3. 더 적은 비용으로'); options.signal!.addEventListener('abort', () => reject(new Error('aborted'))) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const team = teamRunner({ paths: w.paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
      const answer = use(team.tools('bot-b1', w.kit, () => undefined), 'assign', { wait: true, to: [{ who: '지민', brief: '노션 신기능 조사', then: { who: '서연', brief: '홍보 문구 3개 뽑기' } }] })
      await vi.waitFor(() => expect(calls).toBe(2))
      await vi.advanceTimersByTimeAsync(WRITER_HARD_MS + 10)
      vi.useRealTimers()
      expect(await answer).toBe('서연: 지민이 찾은 노션 신기능으로 세 개 뽑아 봤어요. [노션](https://www.notion.com/releases)\n\n1. 일은 에이전트에게\n2. 하루를 맡기세요\n3. 더 적은 비용으로')
    } finally { vi.useRealTimers() }
    expect((await w.members())[1]).toMatchObject({ role: '서연', writer: true, state: 'released', review: { ok: true } })
    await vi.waitFor(async () => expect((await loadBotMemory(w.paths, '_team')).facts.map(fact => fact.text.replace(/ \(.., \d{4}-\d\d-\d\d\)$/, ''))).toEqual(['노션 신기능 조사 → Notion Agent 개선 https://www.notion.com/releases', '홍보 문구 3개 뽑기 (지민한테 받아서) → 1. 일은 에이전트에게 2. 하루를 맡기세요 3. 더 적은 비용으로']))
  })

  // c4b r2 (GROKBOT rule 3): the host-made split ended its turn at once, and words said while its teammates worked never reached it.
  it('words said while a split works change it: a part added joins the one report, a part swapped is stopped and leaves no row', async () => {
    const { plainSplit, plainSteer, steerSplit, employeesReport, listTasks } = await import('core')
    let go!: () => void
    const gate = new Promise<void>(resolve => { go = resolve })
    const w = await staffed(turn => new Promise((resolve, reject) => { turn.signal.addEventListener('abort', () => reject(new Error('aborted'))); void gate.then(() => resolve(`${/이번 주 (\S+) 신기능/.exec(turn.prompt)?.[1]} 새 기능이 나왔어요 https://example.com/${turn.role === '지민' ? 'a' : 'b'}`)) }))
    expect(await w.assign(plainSplit('이번 주 노션, 슬랙 신기능 조사해서 알려줘. 지민, 서연한테 나눠서 시켜', ['지민', '서연'])!)).toBe('지민, 서연한테 나눠 맡겼어요.')
    await vi.waitFor(async () => expect((await w.members()).map(m => m.state)).toEqual(['working', 'working']))
    await updateTask(w.paths, w.id, t => { t.state = 'waiting' })
    await w.team.turnEnded('bot-b1')
    const say = async (words: string) => { const steer = plainSteer(words, await listTasks(w.paths), 'b1'); return steer && await w.team.steer(steer.taskId, 'bot-b1', task => steerSplit(task, steer)) ? steer.said : undefined }
    expect(await say('아 피그마도 추가해')).toBe('피그마도 넣을게요.')
    expect(await say('슬랙 말고 리니어로 바꿔줘')).toBe('슬랙 말고 리니어로 바꿀게요.')
    await vi.waitFor(async () => expect((await w.members()).map(m => [m.role, m.topic, m.state])).toEqual([['지민', '노션', 'working'], ['서연', '슬랙', 'released'], ['지민', '피그마', 'working'], ['서연', '리니어', 'working']]))
    expect(w.reported).toEqual([])
    go()
    await vi.waitFor(() => expect(w.reported).toEqual([`bot-b1 ${w.id}`]))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(w.reported).toEqual([`bot-b1 ${w.id}`])
    const table = employeesReport(await w.task())!
    expect(table.split('\n').filter(row => /^(?:지민|서연): /.test(row)).map(row => row.split(' ').slice(0, 2).join(' '))).toEqual(['지민: 노션', '지민: 피그마', '서연: 리니어'])
    expect(table).not.toContain('슬랙')
    // Once everyone has ended there is no split to change: the words are a turn of their own.
    expect(await say('아 지라도 추가해')).toBeUndefined()
  })

  // c5 (GROKBOT rule 7): the report waited for the slowest part however long it took.
  it('at the cap what is back is reported with the slow part labeled, and that part is reported alone when it lands', async () => {
    const { plainSplit, employeesReport, lateShown } = await import('core')
    let go!: () => void
    const gate = new Promise<void>(resolve => { go = resolve })
    const w = await staffed(turn => turn.role === '지민' ? Promise.resolve('노션이 AI 회의록을 냈어요 https://example.com/a') : new Promise((resolve, reject) => { turn.signal.addEventListener('abort', () => reject(new Error('aborted'))); void gate.then(() => resolve('슬랙이 캔버스 공유를 냈어요 https://example.com/b')) }), { reportCapMs: 60 })
    await w.assign(plainSplit('이번 주 노션, 슬랙 신기능 조사해서 알려줘. 지민, 서연한테 나눠서 시켜', ['지민', '서연'])!)
    await updateTask(w.paths, w.id, t => { t.state = 'waiting' })
    await w.team.turnEnded('bot-b1')
    await vi.waitFor(() => expect(w.reported).toEqual([`bot-b1 ${w.id}`]))
    expect((await w.members()).map(m => [m.role, m.state, m.late])).toEqual([['지민', 'done', undefined], ['서연', 'working', true]])
    const first = employeesReport(await w.task())!
    expect(first).toContain('지민: 노션이 AI 회의록을 냈어요. [출처](https://example.com/a)')
    expect(first).toContain('서연: 슬랙 쪽은 아직 찾는 중이에요. 끝나면 이어서 올릴게요.')
    // The lead's report turn marks it shown (ipc.ts), and the late part's own report follows when it ends.
    await updateTask(w.paths, w.id, lateShown)
    go()
    await vi.waitFor(() => expect(w.reported).toEqual([`bot-b1 ${w.id}`, `bot-b1 ${w.id}`]))
    const second = employeesReport(await w.task())!
    expect(second).toBe('서연: 슬랙이 캔버스 공유를 냈어요. [출처](https://example.com/b)')
    await new Promise(resolve => setTimeout(resolve, 90))
    expect(w.reported).toHaveLength(2)
  })

  it('nothing is reported early when everyone is back before the cap, when nothing is back, or for a hand-off under way', async () => {
    const quick = await staffed(async turn => `${turn.role} 새 기능이 나왔어요 https://example.com/a`, { reportCapMs: 40 })
    await quick.assign({ wait: false, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }] })
    await updateTask(quick.paths, quick.id, t => { t.state = 'waiting' })
    await vi.waitFor(() => expect(quick.reported).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(quick.reported).toHaveLength(1)
    expect((await quick.members()).some(m => m.late)).toBe(false)
    const slow = await staffed(turn => new Promise((_resolve, reject) => turn.signal.addEventListener('abort', () => reject(new Error('aborted')))), { reportCapMs: 30 })
    await slow.assign({ wait: false, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }] })
    await updateTask(slow.paths, slow.id, t => { t.state = 'waiting' })
    await new Promise(resolve => setTimeout(resolve, 90))
    expect(slow.reported).toEqual([])
    expect((await slow.members()).some(m => m.late)).toBe(false)
    await slow.team.stop('bot-b1')
  })

  // stack-4 (c4b-381043c9 C3): the after-launch resume ran while a split's teammates were 0.35 s into their work and closed all three.
  it('the after-launch resume leaves teammates that are at work in this run alone', async () => {
    let go!: () => void
    const gate = new Promise<void>(resolve => { go = resolve })
    const w = await staffed(turn => new Promise((resolve, reject) => { turn.signal.addEventListener('abort', () => reject(new Error('aborted'))); void gate.then(() => resolve('새 기능이 나왔어요 https://example.com/a')) }))
    await w.assign({ wait: false, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }] })
    await vi.waitFor(async () => expect((await w.members()).map(m => m.state)).toEqual(['working', 'working']))
    await updateTask(w.paths, w.id, t => { t.state = 'waiting' })
    await w.team.resume()
    expect((await w.members()).map(m => m.state)).toEqual(['working', 'working'])
    expect(w.reported).toEqual([])
    go()
    await vi.waitFor(() => expect(w.reported).toEqual([`bot-b1 ${w.id}`]))
    expect((await w.members()).map(m => [m.state, m.result?.includes('새 기능')])).toEqual([['done', true], ['done', true]])
  })

  it('a stop aborts background agents and no report follows', async () => {
    const w = await staffed(turn => new Promise((_resolve, reject) => turn.signal.addEventListener('abort', () => reject(new Error('aborted')))))
    await w.assign({ wait: false, to: [{ who: '지민', brief: 'a' }, { who: '서연', brief: 'b' }] })
    await vi.waitFor(async () => expect((await w.members()).map(m => m.state)).toEqual(['working', 'working']))
    await updateTask(w.paths, w.id, t => { t.state = 'stopped' })
    await w.team.stop('bot-b1')
    await vi.waitFor(() => expect(w.pool.running).toBe(0))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect((await w.members()).map(m => m.state)).toEqual(['released', 'released'])
    expect(w.reported).toEqual([])
    const { readBotTranscript } = await import('core')
    expect(await readBotTranscript(w.paths, w.kim.id)).toEqual([])
  })

  it('after a restart a task that waited for a background agent is not left hanging: the member is failed and the lead reports', async () => {
    const w = await staffed(async () => 'unused')
    await updateTask(w.paths, w.id, t => { t.state = 'waiting'; t.team = teamOf(member('m1', 'working', { role: '지민', botId: w.kim.id, background: true })) })
    await w.team.resume()
    expect((await w.members())[0]).toMatchObject({ state: 'failed', result: 'Failed: the app restarted while this member was working.' })
    expect(w.reported).toEqual([`bot-b1 ${w.id}`])
    expect(continuationPrompt(await w.task(), 'report')).toContain('- 지민 [failed]: Failed: the app restarted')
  })
})

describe('team on a running task', () => {
  const teamFor = (s: Awaited<ReturnType<typeof setup>>) => teamRunner({ paths: s.paths, askFor: (c, f, w) => s.runner.askFor(c, f, w), waitingForPerson: c => s.runner.waitingForPerson(c), closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined })
  const seed = (s: { paths: VaultPaths }, team: TaskTeam) => listTasks(s.paths).then(tasks => updateTask(s.paths, tasks.at(-1)!.id, t => { t.team = team }))

  it('a simple ask hires nobody and is done in one turn', async () => {
    const s = await setup(async () => done('It is 3pm.'))
    await s.chat('What time is it?')
    const task = await s.settle('done')
    expect(task.team).toBeUndefined()
    expect(s.sent).toHaveLength(1)
  })

  it("a member's send raises an approval in the lead's thread naming the role, even after the team plan was approved", async () => {
    let answer: Promise<string> | undefined
    let confirmed = ''
    const s: Awaited<ReturnType<typeof setup>> = await setup(async (_request, turn) => {
      if (turn > 1) return readback('sent')
      await seed(s, { ...teamOf(member('m1', 'working', { role: '조사팀' })), big: true, approvedAt: new Date().toISOString() })
      answer = teamFor(s).askFor('bot-bot-1~team-m1', async what => { confirmed = what.words; return 'approve' })!({ words: 'Send mail', url: 'https://mail.example/send' })
      const result = await answer
      await seed(s, teamOf(member('m1', 'released', { role: '조사팀' })))
      return done(`member said ${result}`)
    })
    const chatting = s.chat('메일 보내줘')
    const task = await cards(s.paths, 1)
    expect(task.approvals[0]!.words).toBe('조사팀: Send mail')
    expect(task.state).toBe('running')
    await s.call('tasks:decide', task.id, task.approvals[0]!.id, 'approve')
    await chatting
    expect(await answer).toBe('approve')
    expect(confirmed).toBe('Send mail')
    expect(await teamFor(s).askFor('bot-bot-1~team-m1', async () => 'approve')!({ words: 'Send mail', url: 'https://mail.example/send' })).toBe('cancel')
  })

  const reviewed = () => teamOf(member('m1', 'released', { result: 'ok', review: { ok: true, note: '' } }))
  it('the lead must pass the verify step before team work is done', async () => {
    const s: Awaited<ReturnType<typeof setup>> = await setup(async (_request, turn) => { if (turn === 1) { await seed(s, reviewed()); return done('all three cities are in weather.pdf') } return readback('checked weather.pdf') })
    await s.chat('서울·제주·부산 날씨 조사해서 PDF로')
    const task = await s.settle('done')
    expect(s.sent).toHaveLength(2)
    expect(s.sent[1]!.extra?.verification).toEqual({ goal: '서울·제주·부산 날씨 조사해서 PDF로', result: 'all three cities are in weather.pdf' })
    expect(task.verified).toBe(true)
    expect(task.log.map(l => l.line)).toContain('Checking the team deliverable before reporting done')
  })

  it('team work without an accepted check is never done', async () => {
    const s: Awaited<ReturnType<typeof setup>> = await setup(async (_request, turn) => { if (turn === 1) await seed(s, reviewed()); return done('claimed done') }, false)
    await s.chat('서울·제주·부산 날씨 조사해서 PDF로')
    const task = await s.settle('waiting')
    expect(task.verified).toBe(false)
    expect((await listTasks(s.paths)).some((t: DelegatedTask) => t.state === 'done')).toBe(false)
  })

  it('an offered alternative does not skip the team check', async () => {
    const s: Awaited<ReturnType<typeof setup>> = await setup(async (_request, turn) => { if (turn === 1) await seed(s, reviewed()); return done('another way offered') }, false, undefined, () => true)
    await s.chat('서울·제주·부산 날씨 조사해서 PDF로')
    await s.settle('waiting')
    expect(s.sent[1]!.extra?.verification).toBeDefined()
  })

  it('a passing check does not complete a team task while a member has no parent review', async () => {
    const s: Awaited<ReturnType<typeof setup>> = await setup(async (_request, turn) => { if (turn === 1) { await seed(s, teamOf(member('m1', 'done', { result: 'unread' }))); return done('claimed done') } return readback('checked') })
    await s.chat('서울·제주·부산 날씨 조사해서 PDF로')
    const task = await s.settle('waiting')
    expect(task.verified).toBe(false)
    expect(task.verificationIssue).toContain('Team members not reviewed yet: role m1 (m1)')
  })
})
