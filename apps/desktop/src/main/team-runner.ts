import {
  failOnRestart, listTasks, MEMBER_BLOCKED, memberPersona, memberTask, releaseAll, runComet, SCREEN_TOOL, settleMember, TASK_TOKEN_BUDGET, teamHireTools, teamNote, unreviewed, updateTask,
  type AgentTool, type DelegatedTask, type MemberOutcome, type MemberRedo, type TeamHost, type TeamMember, type VaultPaths,
} from 'core'
import type { Ask } from './page-actions.js'
import { asBackground, whileWaitingForPerson } from './worker-pool.js'
import { flog } from './flog.js'
import { isKorean } from './task-closing.js'

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
  run?: typeof runComet
}) {
  const { paths } = deps
  const live = new Map<string, { control: AbortController; channel: string }>()
  const waitingLanes = new Map<string, number>()
  const inflight = new Map<string, number>()
  const screen = new Map<string, string>()
  const notes = new Map<string, string>()
  const roles = new Map<string, string>()
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
  const tokensLeft = async (taskId: string) => TASK_TOKEN_BUDGET - ((await find(taskId))?.tokensUsed ?? 0) - (inflight.get(taskId) ?? 0)

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
    let used = 0, role = id, goal = ''
    try {
      const member = await change(taskId, task => { const m = task.team?.members.find(one => one.id === id); goal = task.goal; if (m?.state === 'hired' && task.state === 'running') { m.state = 'working'; return structuredClone(m) } return undefined })
      if (!member) return
      role = member.role; roles.set(key, role)
      let outcome: MemberOutcome
      try {
        const native = await kit.nativeFor(lane)
        const tools = (await kit.toolsFor(lane, native)).filter(tool => !MEMBER_BLOCKED.test(tool.name)).map(tool => screenGuard(tool, taskId, member))
        let prompt = memberTask(member, goal, redo)
        for (let round = 0; ; round++) {
          const result = await (deps.run ?? runComet)({ engine: kit.engine, workdir: kit.workdir, tools }, prompt, {
            signal: control.signal, persona: memberPersona(member), session: member.sessionKey, guided: kit.guided, tokenBudget: Math.max(0, budget - used),
            onUsage: tokens => { used += tokens; inflight.set(taskId, (inflight.get(taskId) ?? 0) + tokens) },
            ...(native ? { native } : {}),
            waitingForPerson: () => waitingLanes.has(lane) || deps.waitingForPerson(leadChannel),
            onStep: line => deps.step(leadChannel, line),
          })
          outcome = { answer: result.answer, ...(result.asked ? { asked: true } : {}), ...(result.budgetExhausted ? { budgetExhausted: true } : {}) }
          // A member reports up only after it reviewed its own helpers; it gets one reminder.
          const open = unreviewed((await find(taskId))?.team, id)
          if (!open.length || result.asked || result.budgetExhausted || control.signal.aborted) break
          if (round) { outcome = { answer: '', error: `it reported without reviewing ${open.map(m => m.role).join(', ')}.` }; break }
          prompt = reviewFirst(open)
        }
      } catch (error) { outcome = { answer: '', error: error instanceof Error ? error.message : String(error) } }
      if (control.signal.aborted) outcome = { answer: '', error: 'it was stopped.' }
      await change(taskId, task => {
        task.tokensUsed = (task.tokensUsed ?? 0) + used
        const m = task.team?.members.find(one => one.id === id)
        if (m && m.state !== 'released') settleMember(m, outcome, now())
      })
    } catch (error) { flog('team', error) } finally {
      signal?.removeEventListener('abort', stop)
      live.delete(key)
      const left = (inflight.get(taskId) ?? 0) - used
      if (left > 0) inflight.set(taskId, left); else inflight.delete(taskId)
      if (screen.get(taskId) === id) screen.delete(taskId)
      // Helpers this member left behind do not outlive its turn.
      await release(taskId, unreviewed((await find(taskId).catch(() => undefined))?.team, id).map(m => m.id)).catch(error => flog('team', error))
      deps.endLane(lane)
      deps.step(leadChannel, isKorean(goal) ? `${role} 끝` : `${role} finished`)
    }
  }

  async function runMembers(taskId: string, leadChannel: string, callerLane: string, self: string | null, ids: string[], signal: AbortSignal | undefined, kit: TurnKit, redo?: MemberRedo): Promise<void> {
    const mark = (from: string, to: 'waiting' | 'reviewing') => self ? change(taskId, task => { const m = task.team?.members.find(one => one.id === self); if (m?.state === from) m.state = to }) : undefined
    await mark('working', 'waiting')
    waitingLanes.set(callerLane, (waitingLanes.get(callerLane) ?? 0) + 1)
    try {
      const share = Math.floor(Math.max(0, await tokensLeft(taskId)) / ids.length)
      // The caller's pool slot is given back for the whole wait; each child takes a root slot from the background line.
      await whileWaitingForPerson(() => Promise.all(ids.map(id => asBackground(() => runOne(taskId, leadChannel, id, signal, kit, share, redo)))))
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
    tools(channel: string, kit: TurnKit): AgentTool[] {
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
      }
      return teamHireTools(host)
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
    waiting: (channel: string): boolean => waitingLanes.has(channel),
    note: (channel: string): string => notes.get(channel) ?? '',
    async stop(channel: string): Promise<void> {
      for (const one of live.values()) if (one.channel === channel) one.control.abort()
      for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && t.team?.members.some(m => m.state !== 'released'))) {
        for (const key of await change(task.id, t => t.team ? releaseAll(t.team, now()) : []) ?? []) deps.closeSession(key)
        screen.delete(task.id)
      }
      notes.delete(channel)
    },
    settled: settle,
    // Members left by a task that ended, or lost when their lead's turn ended, do not stay open.
    async turnEnded(channel: string): Promise<void> {
      for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && t.team)) {
        if (TERMINAL.includes(task.state)) { if (task.team!.members.some(m => m.state !== 'released')) await settle(task); continue }
        const lost = task.team!.members.filter(m => ['hired', 'working'].includes(m.state) && !live.has(`${task.id}/${m.id}`))
        if (lost.length) await change(task.id, t => { for (const m of t.team?.members ?? []) if (lost.some(l => l.id === m.id) && ['hired', 'working'].includes(m.state)) { m.state = 'failed'; m.result = 'Failed: its lead\'s turn ended.'; m.finishedAt = now() } })
      }
    },
    async resume(): Promise<void> {
      for (const task of (await listTasks(paths)).filter(t => t.team)) {
        for (const m of task.team!.members) deps.closeSession(m.sessionKey)
        await change(task.id, t => { if (!t.team) return; if (TERMINAL.includes(t.state)) releaseAll(t.team, now()); else failOnRestart(t.team, now()) })
      }
    },
  }
}
