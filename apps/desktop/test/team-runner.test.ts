import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createTask, listTasks, updateTask, type AgentTool, type DelegatedTask, type TaskTeam, type TeamMember, type VaultPaths } from 'core'
import { cards, done, readback, setup } from './task-runner-fixture.js'
import { memberLane, teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { withLease, WorkerPool } from '../src/main/worker-pool.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Turn = { tools: AgentTool[]; prompt: string; signal: AbortSignal; session: string; role: string }
const reply = (answer: string) => ({ answer, steps: [], fellBack: false })
const use = (tools: AgentTool[], name: string, args: Record<string, unknown> = {}) => tools.find(tool => tool.name === name)!.run(args, { task: '' })
const member = (id: string, state: TeamMember['state'], more: Partial<TeamMember> = {}): TeamMember => ({ id, parentId: null, depth: 1, role: `role ${id}`, brief: 'part', state, sessionKey: `team-x-${id}`, hiredAt: new Date().toISOString(), ...more })
const teamOf = (...members: TeamMember[]): TaskTeam => ({ members, hires: members.length, maxHires: 8, maxDepth: 3, big: false })
const three = { members: [{ role: 'seoul', brief: 'Seoul weather' }, { role: 'jeju', brief: 'Jeju weather' }, { role: 'busan', brief: 'Busan weather' }] }

async function world(base: number, script: (turn: Turn) => Promise<string>) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'engram-team-')), paths = { cache: join(root, '.engram') } as unknown as VaultPaths
  const pool = new WorkerPool({ base, sample: async () => ({ freePct: 60, swapGrowthBytes: 0, cpuBusyPct: 10 }), log: () => undefined })
  const created = await createTask(paths, 'Research the weather in Seoul, Jeju and Busan', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const closed: string[] = [], seen: Turn[] = [], ended: string[] = []
  const peak = { running: 0, working: 0, top: 0 }
  const run: Run = async (deps, prompt, options = {}) => {
    const lease = await pool.lease(options.signal)
    if (!lease) throw new Error('aborted')
    peak.running = Math.max(peak.running, pool.running)
    const turn = { tools: deps.tools, prompt, signal: options.signal!, session: options.session!, role: /"(.+?)"/.exec(options.persona ?? '')?.[1] ?? '' }
    seen.push(turn)
    try {
      return reply(await withLease(lease, async () => {
        peak.top = Math.max(peak.top, ++peak.working)
        try { return await script(turn) } finally { peak.working-- }
      }))
    } finally { lease.end() }
  }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: key => closed.push(key), endLane: lane => ended.push(lane), step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), { name: 'app_click', description: '', argsSchema: {}, run: async () => 'clicked' }, { name: 'new_bot', description: '', argsSchema: {}, run: async () => '' }] }
  // The lead's turn holds a pool slot, as a real turn's tools do.
  const lead = async (name: string, args: Record<string, unknown> = {}) => {
    const lease = (await pool.lease())!
    try { return await withLease(lease, () => use(team.tools('bot-b1', kit), name, args)) } finally { expect(lease.held).toBe(true); lease.end() }
  }
  const task = async () => (await listTasks(paths)).find(t => t.id === created.id)!
  const members = async () => (await task()).team!.members
  return { paths, pool, team, kit, lead, task, members, closed, seen, ended, peak, id: created.id }
}

describe('team runner', () => {
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
    expect(out.members[0]).toMatchObject({ state: 'failed', result: 'Failed: it reported without reviewing helper.' })
    expect((await w.members())[1]).toMatchObject({ state: 'released' })
    expect((await w.members())[1]!.review).toBeUndefined()
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
    expect(s.sent[1]!.extra?.verification).toEqual({ result: 'all three cities are in weather.pdf' })
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
