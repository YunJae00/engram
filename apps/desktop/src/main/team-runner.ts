import {
  backgroundOpen, cutShortAnswer, failOnRestart, listTasks, LOOKUP_HARD_MS, LOOKUP_MAX_CALLS, LOOKUP_SOFT_MS, LOOKUP_TOOLS, MEMBER_BLOCKED, MEMBER_RESULT_CHARS, memberPersona, memberTask, releaseAll, runComet, SCREEN_TOOL, settleMember, skipWalls, TASK_TOKEN_BUDGET, teamHireTools, teamNote, unreviewed, updateTask,
  type AgentTool, type DelegatedTask, type Engine, type MemberOutcome, type MemberRedo, type TeamHost, type TeamMember, type ToolSessionJob, type VaultPaths,
} from 'core'
import type { Ask } from './page-actions.js'
import { asBackground, inCallerSlot, whileWaitingForPerson } from './worker-pool.js'
import { flog } from './flog.js'
import { isKorean } from './task-closing.js'
import { assignTool, employeeNote, employeeWriteBack, handoffBrief, logTask } from 'core'

// Runs the hidden team of a task: each member is its own engine turn on a lane of the lead's channel.
type Deps = Parameters<typeof runComet>[0]
type Native = NonNullable<Parameters<typeof runComet>[2]>['native']
export const memberLane = (channel: string, id: string): string => `${channel}~team-${id}`
export const laneMember = (lane: string): RegExpExecArray | null => /^(bot-[^~]+)~team-(m\d+)$/.exec(lane)
export const leadOf = (lane: string): string => laneMember(lane)?.[1] ?? lane

// What one lead or member turn hands over so its members can be run the same way.
export interface TurnKit {
  engine: Deps['engine']; workdir: Deps['workdir']; guided: boolean; said(): string
  nativeFor(lane: string): Promise<Native>
  toolsFor(lane: string, native: Native): Promise<AgentTool[]>
}

const TERMINAL = ['done', 'failed', 'stopped']
const reviewFirst = (open: TeamMember[]) => `You reported without reviewing the helpers you hired: ${open.map(m => `${m.role} (${m.id})`).join(', ')}. Read what each returned, call review_member for each one, then report your result again.`

export function teamRunner(deps: {
  paths: VaultPaths
  askFor(channel: string, confirm: Ask, waitMs?: number): Ask | undefined
  waitingForPerson(channel: string): boolean
  closeSession(key: string): void
  endLane(lane: string): void
  step(channel: string, line: string): void
  changed(): void
  // Resolves when the person says something in this lead's thread mid-turn (a lead waiting on its members hears it at once).
  steered?(channel: string, signal: AbortSignal): Promise<void>
  /** A conversation has a turn of its own under way: an agent's finished job is written to their conversation after it. */
  busy?(channel: string): boolean
  run?: typeof runComet
  // Test seam: a lookup member's hard time limit.
  lookupHardMs?: number
}) {
  const { paths } = deps
  const live = new Map<string, { control: AbortController; channel: string }>()
  const waitingLanes = new Map<string, number>()
  const inflight = new Map<string, number>()
  const screen = new Map<string, string>()
  const notes = new Map<string, string>()
  const roles = new Map<string, string>()
  // Lead channels being stopped: a member that ends because of the stop leaves no late result; the stop releases it.
  const halting = new Set<string>()
  // The lead's running tool session per lead channel: member tokens count against the lead's turn budget, so lead plus team never pass it.
  const leads = new Map<string, { job: ToolSessionJob; spent: number }>()
  // Told when the background members of a task have all ended: the lead reports in a turn of its own (task-runner report).
  let report: ((channel: string, taskId: string) => void) | undefined
  const charge = (leadChannel: string, tokens: number) => { const lead = leads.get(leadChannel); if (!lead) return false; lead.spent += tokens; lead.job.onUsage?.(tokens); return true }
  const channelOf = (task: DelegatedTask) => `bot-${task.botId}`
  const now = () => new Date().toISOString()
  const find = async (taskId: string) => (await listTasks(paths)).find(t => t.id === taskId)
  const remember = (task: DelegatedTask) => { if (task.team && !TERMINAL.includes(task.state)) notes.set(channelOf(task), teamNote(task.team)); else notes.delete(channelOf(task)) }
  async function change<T>(taskId: string, work: (task: DelegatedTask) => T): Promise<T | undefined> {
    let out: T | undefined
    const task = await updateTask(paths, taskId, t => { out = work(t) })
    if (task) remember(task)
    deps.changed()
    return task ? out : undefined
  }
  const tokensLeft = async (taskId: string) => { const task = await find(taskId); return TASK_TOKEN_BUDGET - (task?.tokensUsed ?? 0) - (task ? leads.get(channelOf(task))?.spent ?? 0 : 0) - (inflight.get(taskId) ?? 0) }

  async function release(taskId: string, ids: string[]): Promise<void> {
    if (!ids.length) return
    const keys = await change(taskId, task => (task.team?.members ?? []).filter(m => ids.includes(m.id) && m.state !== 'released').map(m => { m.state = 'released'; m.finishedAt ??= now(); return m.sessionKey }))
    for (const key of keys ?? []) deps.closeSession(key)
  }

  // At most one member of a task drives the screen; a second one is refused rather than queued, so a parent cannot block its own helper.
  function screenGuard(tool: AgentTool, taskId: string, member: TeamMember): AgentTool {
    if (!SCREEN_TOOL.test(tool.name)) return tool
    const take = () => {
      const holder = screen.get(taskId)
      if (holder && holder !== member.id) throw new Error(`${roles.get(`${taskId}/${holder}`) ?? holder} is using the screen. Do the parts that need no screen, or report that the screen was busy.`)
      screen.set(taskId, member.id)
    }
    return { ...tool, run: async (args, context) => { take(); return tool.run(args, context) }, ...(tool.runRich ? { runRich: async (args, context) => { take(); return tool.runRich!(args, context) } } : {}) }
  }

  async function runOne(taskId: string, leadChannel: string, id: string, signal: AbortSignal | undefined, kit: TurnKit, budget: number, redo?: MemberRedo): Promise<void> {
    const key = `${taskId}/${id}`, lane = memberLane(leadChannel, id)
    const control = new AbortController(), stop = () => control.abort()
    if (signal?.aborted) control.abort(); else signal?.addEventListener('abort', stop, { once: true })
    live.set(key, { control, channel: leadChannel })
    let used = 0, role = id, goal = '', ended: TeamMember['state'] | undefined, done: { botId: string; brief: string; result: string } | undefined
    // Tokens a lead session already counts are saved with the lead's turn, not again here.
    let charged = leads.has(leadChannel)
    try {
      const member = await change(taskId, task => { const m = task.team?.members.find(one => one.id === id); goal = task.goal; if (m?.state === 'hired' && (task.state === 'running' || (m.background && !TERMINAL.includes(task.state)))) { m.state = 'working'; return { me: structuredClone(m), helpers: redo ? structuredClone(unreviewed(task.team, id)) : [] } } return undefined })
      if (!member) return
      const { me, helpers } = member
      role = me.role; roles.set(key, role)
      // A background member outlives the lead's turn: its tokens are saved with the task, never against a lead session that may be gone.
      if (me.background) charged = false
      // An agent on the team works as themselves: their role and what they remember ride with the member rules.
      const persona = memberPersona(me) + (me.botId ? await employeeNote(paths, me.botId) : '')
      let outcome: MemberOutcome
      // A lookup member is time-boxed: the lead waits for it no longer than the hard limit, and gets what it wrote by then.
      // The limit counts the member's own working time, from when its session starts: one still in line is not stopped before it began (perf146 r2).
      let timedOut = false, draft = '', read = false, hardStop: ReturnType<typeof setTimeout> | undefined
      const begun = () => { if (me.lookup) hardStop ??= setTimeout(() => { timedOut = true; control.abort() }, deps.lookupHardMs ?? LOOKUP_HARD_MS) }
      try {
        // Reading tools only and no shell for a lookup member: a small menu the model sees whole.
        const native = me.lookup ? undefined : await kit.nativeFor(lane)
        const tools = (await kit.toolsFor(lane, native)).filter(tool => !MEMBER_BLOCKED.test(tool.name) && (!me.lookup || LOOKUP_TOOLS.has(tool.name))).map(tool => screenGuard(me.lookup ? skipWalls(tool) : tool, taskId, me))
        let prompt = memberTask(me, goal, redo, helpers)
        for (let round = 0; ; round++) {
          const result = await (deps.run ?? runComet)({ engine: kit.engine, workdir: kit.workdir, tools }, prompt, {
            signal: control.signal, persona, session: me.sessionKey, guided: kit.guided, tokenBudget: Math.max(0, budget - used),
            onStart: begun,
            onUsage: tokens => { begun(); used += tokens; if (!(charged && charge(leadChannel, tokens))) inflight.set(taskId, (inflight.get(taskId) ?? 0) + tokens) },
            ...(native ? { native } : {}),
            waitingForPerson: () => waitingLanes.has(lane) || deps.waitingForPerson(leadChannel),
            onStep: line => { read = true; deps.step(leadChannel, line) },
            ...(me.lookup ? { modelHint: 'smart' as const, maxCalls: LOOKUP_MAX_CALLS, deadlineMs: LOOKUP_SOFT_MS, onToken: (text: string) => { begun(); draft += text }, onReset: () => { draft = '' } } : {}),
          })
          const cutShort = !!me.lookup && result.stopped === 'calls' && !result.asked
          outcome = { answer: cutShort ? cutShortAnswer(result.answer) : result.answer, ...(result.asked ? { asked: true } : {}), ...(result.budgetExhausted ? { budgetExhausted: true } : {}), ...(cutShort ? { timedOut: true } : {}) }
          // A member reports up only after it reviewed its own helpers; it gets one reminder.
          const open = unreviewed((await find(taskId))?.team, id)
          if (!open.length || result.asked || result.budgetExhausted || control.signal.aborted) break
          if (round) { outcome = { answer: '', error: `it reported without reviewing ${open.map(m => m.role).join(', ')}.` }; break }
          prompt = reviewFirst(open)
        }
      } catch (error) { outcome = { answer: '', error: error instanceof Error ? error.message : String(error) } } finally { clearTimeout(hardStop) }
      // Only what it wrote after reading something is a result: words before its first tool call are an opening line, not findings (perf146 r3).
      if (timedOut && !signal?.aborted) outcome = { answer: read ? draft : '', timedOut: true }
      else if (control.signal.aborted) outcome = { answer: '', error: 'it was stopped.' }
      await change(taskId, task => {
        if (!charged) task.tokensUsed = (task.tokensUsed ?? 0) + used
        const m = task.team?.members.find(one => one.id === id)
        if (m && m.state !== 'released' && !(control.signal.aborted && !timedOut && halting.has(leadChannel))) settleMember(m, outcome, now(), isKorean(goal))
        ended = m?.state
        if (m?.botId && ended === 'done') done = { botId: m.botId, brief: m.brief, result: m.result ?? '' }
      })
      if (done) {
        // An agent mid-turn in their own conversation gets the job on their record when that turn ends; nobody here waits for it.
        const busy = () => deps.busy?.(`bot-${done!.botId}`) ?? false, wrote = employeeWriteBack(paths, done, undefined, busy).catch(error => flog('team', error))
        if (!busy()) await wrote
      }
    } catch (error) { flog('team', error) } finally {
      signal?.removeEventListener('abort', stop)
      live.delete(key)
      if (!charged) { const left = (inflight.get(taskId) ?? 0) - used; if (left > 0) inflight.set(taskId, left); else inflight.delete(taskId) }
      if (screen.get(taskId) === id) screen.delete(taskId)
      // A member waiting on the person keeps its helpers for review when it resumes; any other end passes them up unreviewed, said so.
      if (ended !== 'waiting' && !halting.has(leadChannel)) await orphan(taskId, id, ended).catch(error => flog('team', error))
      deps.endLane(lane)
      deps.step(leadChannel, isKorean(goal) ? `${role} 끝` : `${role} finished`)
    }
  }

  // A member, then whoever its result is handed to (TeamMember.then): one hop, only after it ended done, and it counts as a hire.
  async function chain(taskId: string, leadChannel: string, id: string, signal: AbortSignal | undefined, kit: TurnKit, budget: number, redo?: MemberRedo): Promise<void> {
    await runOne(taskId, leadChannel, id, signal, kit, budget, redo)
    if (redo) return
    const next = await change(taskId, task => {
      const team = task.team, m = team?.members.find(one => one.id === id)
      if (!team || !m?.then || m.state !== 'done' || team.hires >= team.maxHires) return undefined
      const to = `m${team.members.length + 1}`
      team.members.push({ id: to, parentId: m.parentId, depth: m.depth, role: m.then.who, brief: handoffBrief(m.then.brief, m.role, m.result ?? '', m.brief), botId: m.then.botId, lookup: true, ...(m.background ? { background: true as const } : {}), state: 'hired', sessionKey: `team-${task.id}-${to}`, hiredAt: now() })
      team.hires++
      logTask(task, `${m.role} handed over to ${m.then.who}`)
      return to
    })
    if (next) await runOne(taskId, leadChannel, next, signal, kit, budget)
  }

  // Members nobody waits for (assign with wait false). When the last of a task's has ended, its lead is told to report.
  async function later(taskId: string, leadChannel: string, ids: string[], kit: TurnKit): Promise<void> {
    const share = Math.floor(Math.max(0, await tokensLeft(taskId)) / ids.length)
    const light = new Set(((await find(taskId))?.team?.members ?? []).filter(m => m.lookup).map(m => m.id))
    void Promise.all(ids.map(id => (light.has(id) ? inCallerSlot : asBackground)(() => chain(taskId, leadChannel, id, undefined, kit, share)))).then(async () => {
      const task = await find(taskId)
      if (task && !TERMINAL.includes(task.state) && !halting.has(leadChannel) && !backgroundOpen(task)) report?.(leadChannel, taskId)
    }).catch(error => flog('team', error))
  }

  async function orphan(taskId: string, id: string, ended: TeamMember['state'] | undefined): Promise<void> {
    const keys = await change(taskId, task => {
      const parent = task.team?.members.find(one => one.id === id), open = unreviewed(task.team, id)
      if (!open.length) return []
      const why = ended === 'failed' ? (parent?.result ?? 'it failed') : ended === 'done' ? 'it reached the token budget' : 'it was stopped'
      for (const m of open) { m.state = 'released'; m.finishedAt ??= now(); m.review = { ok: false, note: `Not reviewed: ${parent?.role ?? id} ended before reviewing it (${why.slice(0, 200)}).` } }
      if (parent && parent.state !== 'released') parent.result = `${parent.result ?? ''}\n\nNot reviewed by ${parent.role} (check before you accept): ${open.map(m => `${m.role}: ${(m.result ?? '(no result)').replace(/\s+/g, ' ')}`).join(' | ')}`.slice(0, MEMBER_RESULT_CHARS)
      return open.map(m => m.sessionKey)
    })
    for (const key of keys ?? []) deps.closeSession(key)
  }

  async function runMembers(taskId: string, leadChannel: string, callerLane: string, self: string | null, ids: string[], signal: AbortSignal | undefined, kit: TurnKit, redo?: MemberRedo): Promise<void> {
    const mark = (from: string, to: 'waiting' | 'reviewing') => self ? change(taskId, task => { const m = task.team?.members.find(one => one.id === self); if (m?.state === from) m.state = to }) : undefined
    await mark('working', 'waiting')
    waitingLanes.set(callerLane, (waitingLanes.get(callerLane) ?? 0) + 1)
    try {
      const share = Math.floor(Math.max(0, await tokensLeft(taskId)) / ids.length)
      // The caller's pool slot is given back for the whole wait; each child takes a root slot from the background line.
      // Lookup members are light and work side by side in the caller's slot: when all are, the caller keeps its slot for them.
      const light = new Set(((await find(taskId))?.team?.members ?? []).filter(m => m.lookup && ids.includes(m.id)).map(m => m.id))
      const all = () => Promise.all(ids.map(id => (light.has(id) ? inCallerSlot : asBackground)(() => chain(taskId, leadChannel, id, signal, kit, share, redo))))
      await (light.size === ids.length ? all() : whileWaitingForPerson(all))
    } finally {
      const left = (waitingLanes.get(callerLane) ?? 1) - 1
      if (left) waitingLanes.set(callerLane, left); else waitingLanes.delete(callerLane)
      await mark('waiting', 'reviewing')
    }
  }

  async function settle(task: DelegatedTask): Promise<void> {
    if (!task.team) return
    for (const m of task.team.members) deps.closeSession(m.sessionKey)
    if (TERMINAL.includes(task.state)) { if (task.team.members.some(m => m.state !== 'released')) await change(task.id, t => { if (t.team) releaseAll(t.team, now()) }); notes.delete(channelOf(task)) }
  }

  return {
    // The lead's engine for one turn: its tool session is known here, so members' tokens are charged to it.
    leadEngine(channel: string, engine: Engine): Engine {
      if (laneMember(channel) || !/^bot-[^~]+$/.test(channel) || !engine.runTools) return engine
      const runTools = async (job: ToolSessionJob) => {
        const lead = { job, spent: 0 }
        leads.set(channel, lead)
        try { return await engine.runTools!({ ...job, onUsage: tokens => { lead.spent += tokens; job.onUsage?.(tokens) } }) } finally { if (leads.get(channel) === lead) leads.delete(channel) }
      }
      return new Proxy(engine, { get: (target, prop) => { if (prop === 'runTools') return runTools; const value = Reflect.get(target, prop, target) as unknown; return typeof value === 'function' ? value.bind(target) : value } })
    },
    // staffChanged is given on the primary thread's own turn only: it alone may hand work to agents on the team (assign).
    tools(channel: string, kit: TurnKit, staffChanged?: () => void): AgentTool[] {
      const leadChannel = leadOf(channel), self = laneMember(channel)?.[2] ?? null
      if (!/^bot-[^~]+$/.test(leadChannel)) return []
      const load = async () => (await listTasks(paths)).find(t => t.state === 'running' && channelOf(t) === leadChannel)
      const host: TeamHost = {
        self, load,
        change: async work => { const task = await load(); return task ? change(task.id, work) : undefined },
        run: async (ids, signal, redo) => { const task = await load(); if (task) await runMembers(task.id, leadChannel, channel, self, ids, signal, kit, redo) },
        release: async ids => { const task = await load(); if (task) await release(task.id, ids) },
        live: id => [...live.keys()].some(key => key.endsWith(`/${id}`) && live.get(key)!.channel === leadChannel),
        tokensLeft: async () => { const task = await load(); return task ? tokensLeft(task.id) : 0 },
        personSaid: kit.said,
        ...(self === null && deps.steered ? { steered: (signal: AbortSignal) => deps.steered!(leadChannel, signal) } : {}),
      }
      if (!staffChanged || self !== null) return teamHireTools(host)
      return [...teamHireTools(host), assignTool(paths, {
        ...host,
        later: async ids => { const task = await load(); if (task) await later(task.id, leadChannel, ids, kit) },
        // The job that agent is on right now in this thread, whichever task of the thread it belongs to.
        attach: async (botId, then) => {
          for (const [key, one] of live) {
            if (one.channel !== leadChannel) continue
            const [taskId, id] = key.split('/') as [string, string]
            if (await change(taskId, task => { const m = task.team?.members.find(x => x.id === id); if (m?.botId !== botId || m.then || !['hired', 'working'].includes(m.state)) return false; m.then = then; return true })) return true
          }
          return false
        },
      }, staffChanged)]
    },
    // A member's approval is raised on the lead's task, with the member's role in front.
    askFor(channel: string, confirm: Ask, waitMs?: number): Ask | undefined {
      const lane = laneMember(channel)
      if (!lane) return deps.askFor(channel, confirm, waitMs)
      const [, leadChannel, id] = lane as unknown as [string, string, string]
      return (async what => {
        const task = (await listTasks(paths)).find(t => t.state === 'running' && channelOf(t) === leadChannel)
        const prefix = `${task?.team?.members.find(m => m.id === id)?.role ?? id}: `
        const ask = deps.askFor(leadChannel, own => confirm({ ...own, words: own.words.startsWith(prefix) ? own.words.slice(prefix.length) : own.words }), waitMs)
        return ask ? ask({ ...what, words: `${prefix}${what.words}` }) : 'cancel'
      }) as Ask
    },
    reportTo(tell: (channel: string, taskId: string) => void): void { report = tell },
    waiting: (channel: string): boolean => waitingLanes.has(channel),
    note: (channel: string): string => notes.get(channel) ?? '',
    async stop(channel: string): Promise<void> {
      halting.add(channel)
      try {
        for (const one of live.values()) if (one.channel === channel) one.control.abort()
        for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && t.team?.members.some(m => m.state !== 'released'))) {
          for (const key of await change(task.id, t => t.team ? releaseAll(t.team, now()) : []) ?? []) deps.closeSession(key)
          screen.delete(task.id)
        }
        notes.delete(channel)
      } finally { halting.delete(channel) }
    },
    settled: settle,
    // Members left by a task that ended, or lost when their lead's turn ended, do not stay open.
    async turnEnded(channel: string): Promise<void> {
      for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && t.team)) {
        if (TERMINAL.includes(task.state)) { if (task.team!.members.some(m => m.state !== 'released')) await settle(task); continue }
        // A background member is not this turn's: it ends by itself, by a stop, or by a restart.
        const lost = task.team!.members.filter(m => ['hired', 'working'].includes(m.state) && !m.background && !live.has(`${task.id}/${m.id}`))
        if (lost.length) await change(task.id, t => { for (const m of t.team?.members ?? []) if (lost.some(l => l.id === m.id) && ['hired', 'working'].includes(m.state)) { m.state = 'failed'; m.result = 'Failed: its lead\'s turn ended.'; m.finishedAt = now() } })
      }
    },
    async resume(): Promise<void> {
      for (const task of (await listTasks(paths)).filter(t => t.team)) {
        for (const m of task.team!.members) deps.closeSession(m.sessionKey)
        await change(task.id, t => { if (!t.team) return; if (TERMINAL.includes(t.state)) releaseAll(t.team, now()); else failOnRestart(t.team, now()) })
        // A task that was waiting only for its background members has nobody left to wake it: its lead reports what there is, lost work included.
        if (task.state === 'waiting' && !task.question && task.team!.members.some(m => m.background)) report?.(channelOf(task), task.id)
      }
    },
  }
}
