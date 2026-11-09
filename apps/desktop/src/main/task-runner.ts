import { withModelCallContext } from './model-call-metrics.js'
import { readCheckpoint } from './comet-checkpoint.js'
import { taskQueued } from './task-notify.js'
import { ipcMain } from 'electron'
import {
  continuationPrompt,
  createTask,
  findPlaybook,
  hostOf,
  listTasks,
  localDay,
  logTask,
  playbookContext,
  readBotTranscript,
  recordPlaybook,
  TASK_MAX_TURNS,
  TASK_TOKEN_BUDGET,
  tasksToResume,
  updateTask,
  type DelegatedTask,
  type MeaningScores,
  type TurnStep,
  type VaultPaths,
} from 'core'
import type { ChatRequestDto, EngramEvent } from '../shared/types.js'
import type { TurnEvidence } from 'core'
import type { Ask } from './page-actions.js'
import { flog } from './flog.js'
import { freshResultReadback } from './task-result-state.js'


export interface TurnOutcome { tokensUsed?: number; budgetExhausted?: boolean; answer: string; asked: boolean; unfinished: boolean; unfinishedReason?: string; steps: number; trail?: TurnStep[]; check?: { accepted: boolean; verified?: boolean; issues: string[]; report?: Omit<TurnEvidence, 'record'> }; held?: boolean }
export interface TaskTurn { tokenBudget?: number; context?: string; quiet?: boolean; verification?: { result: string }; holdIf?: (answer: string, steps: TurnStep[]) => boolean }
type Reason = Parameters<typeof continuationPrompt>[1]
const AUTO_CONTINUE_MAX = 3
const WORTH_KEEPING_STEPS = 3
const RESTARTED = 'The app restarted during this task. Check any external changes before asking me to continue.'
const savedFile = (text = '') => /\]\(engram-artifact:/.test(text)
const exactKey = (url: string, words: string) => `${url}\n${words}`
// Command approvals (file:) share one kind per host and sandbox side; every other url keeps its exact key.
const kindOf = (url: string, words: string): string => {
  if (!url.startsWith('file:')) return exactKey(url, words)
  try { const u = new URL(url); return `file://${u.host}${u.hash ? '#' : ''}` } catch { return exactKey(url, words) }
}

export function taskRunner(deps: {
  paths: VaultPaths
  send(request: ChatRequestDto, turn?: TaskTurn): Promise<void>
  outcome(channel: string): TurnOutcome | undefined
  abort(channel: string): void
  broadcast(event: EngramEvent): void
  remember(text: string): Promise<void>
  deliver(channel: string, text: string, since: number, trail: TurnStep[], evidence?: TurnEvidence): Promise<void>
  checkBudgetMs?: number
  learn?(question: string, answer: string): void
  notify(task: DelegatedTask): void
  offered?(channel: string): boolean
  meaning?: MeaningScores
}) {
  const { paths } = deps
  const running = new Set<string>()
  const channels = new Set<string>()
  const acquire = (channel: string) => {
    if (channels.has(channel)) return
    channels.add(channel)
    deps.broadcast({ type: 'comet:working', channel, working: true })
  }
  const release = (channel: string) => {
    if (channels.delete(channel)) deps.broadcast({ type: 'comet:working', channel, working: false })
  }
  const stopped = new Set<string>()
  const waiting = new Map<string, number>()
  const owners = new Map<string, string>()
  const approved = new Map<string, { url: string; words: string }[]>()
  const approvalScopes = new Map<string, Map<string, string>>()
  const alwaysFor = new Map<string, Set<string>>()
  const declined = new Map<string, Set<string>>()
  // Tasks whose person declined a card during the turn now running; that turn is not continued automatically.
  const refusedThisTurn = new Set<string>()
  const trails = new Map<string, TurnStep[]>()
  const handedBack = new Set<string>()
  const continuations = new Map<string, { count: number; reason: string }>()
  const verifyAttempts = new Set<string>()
  const verifyNext = new Set<string>()
  // task id -> unanswered card id -> deferred same-kind requests that become a card once that card is answered
  const held = new Map<string, Map<string, { url: string; words: string }[]>>()
  const newCard = (t: DelegatedTask, url: string, words: string) => { const id = `a-${Date.now().toString(36)}-${t.approvals.length}`; t.approvals.push({ id, words, host: hostOf(url) ?? '', url, at: new Date().toISOString() }); return id }
  const keep = (id: string, a: { url: string; words: string; answer?: string }) => {
    if (a.answer === 'approve-task') alwaysFor.set(id, (alwaysFor.get(id) ?? new Set()).add(kindOf(a.url, a.words)))
    if (a.answer === 'decline') declined.set(id, (declined.get(id) ?? new Set()).add(exactKey(a.url, a.words)))
  }
  const covered = (t: DelegatedTask, url: string, words: string) => !!alwaysFor.get(t.id)?.has(kindOf(url, words)) || (url.startsWith('file:') && t.approvals.some(a => a.answer === 'approve-task' && kindOf(a.url, a.words) === kindOf(url, words)))
  const refused = (t: DelegatedTask, url: string, words: string) => !!declined.get(t.id)?.has(exactKey(url, words)) || t.approvals.some(a => a.answer === 'decline' && a.settled && a.url === url && a.words === words)
  const blocker = (t: DelegatedTask, url: string, words: string) => url.startsWith('file:') ? t.approvals.find(a => !a.answer && !a.settled && (a.url !== url || a.words !== words) && kindOf(a.url, a.words) === kindOf(url, words)) : undefined
  const hold = (id: string, cardId: string, url: string, words: string) => { const byCard = held.get(id) ?? new Map<string, { url: string; words: string }[]>(); byCard.set(cardId, [...(byCard.get(cardId) ?? []).filter(h => h.url !== url || h.words !== words), { url, words }]); held.set(id, byCard) }
  const changed = () => deps.broadcast({ type: 'tasks:changed' })
  const channelOf = (task: DelegatedTask) => `bot-${task.botId}`
  const edit = async (id: string, change: (task: DelegatedTask) => void) => { const task = await updateTask(paths, id, change); changed(); return task }

  async function turn(id: string, request: ChatRequestDto, extra?: TaskTurn): Promise<DelegatedTask | undefined> {
    const started = await edit(id, (t) => {
      if (stopped.has(channelOf(t)) || !['queued', 'running', 'waiting'].includes(t.state)) { t.state = 'stopped'; return }
      if ((t.tokensUsed ?? 0) >= TASK_TOKEN_BUDGET || t.turns >= TASK_MAX_TURNS) {
        t.state = 'failed'; logTask(t, 'Stopped at the task budget or fallback turn limit.'); return
      }
      t.state = 'running'; delete t.question; delete t.verified; delete t.verificationIssue; t.turns++
    })
    if (!started || started.state !== 'running' || stopped.has(channelOf(started))) {
      if (started?.state === 'failed') deps.broadcast({ type: 'chat:done', channel: channelOf(started), text: started.log.at(-1)?.line ?? 'Task stopped.' })
      return started
    }
    if (extra?.quiet) deps.broadcast({ type: 'comet:continue', channel: channelOf(started), botId: started.botId })
    const earlier = trails.get(id) ?? []
    refusedThisTurn.delete(id)
    await withModelCallContext({ channel: channelOf(started), task: id, turn: started.turns, purpose: 'task' }, () => deps.send(request, { ...extra, tokenBudget: Math.max(0, TASK_TOKEN_BUDGET - (started.tokensUsed ?? 0)) }))
    const refused = refusedThisTurn.delete(id)
    approved.set(id, (approved.get(id) ?? []).filter(grant => !grant.url.startsWith('engram://app/')))
    const outcome = deps.outcome(request.channel ?? '')
    const trail = [...earlier, ...(outcome?.trail ?? [])]
    trails.set(id, trail)
    const after = await edit(id, (t) => {
      if (t.state !== 'running') return
      if (stopped.has(channelOf(t))) { t.state = 'stopped'; logTask(t, 'Stopped by you'); return }
      t.tokensUsed = (t.tokensUsed ?? 0) + Math.max(0, outcome?.tokensUsed ?? 0)
      t.work = (t.work ?? 0) + (outcome?.steps ?? 0)
      if (outcome) t.result = outcome.answer
      if (outcome?.check) {
        t.verified = outcome.check.accepted && outcome.check.verified !== false && outcome.check.issues.length === 0 && !outcome.unfinished && !outcome.budgetExhausted && freshResultReadback(outcome.trail ?? [])
        if (!t.verified) t.verificationIssue = outcome.check.issues.join('; ') || 'The result has no fresh readback.'
        else delete t.verificationIssue
      }
      delete t.verificationPending
      const pending = t.approvals.filter((a) => !a.answer)
      if (!outcome) { t.state = 'failed'; logTask(t, 'The turn ended without an answer.') }
      else if (outcome.budgetExhausted) { t.state = 'failed'; logTask(t, 'Stopped at the task token budget.') }
      else if (outcome.asked) { t.state = 'waiting'; t.question = outcome.answer; logTask(t, 'Waiting for your answer') }
      else if (refused && (outcome.unfinished || (outcome.check && !t.verified))) { t.state = 'waiting'; logTask(t, 'You declined a command, so this turn stopped. Waiting for your next instruction.') }
      else if (deps.offered?.(channelOf(t)) && !outcome.unfinished && !pending.length && (!outcome.check || t.verified)) { handedBack.add(t.id); t.state = 'done'; logTask(t, 'Handed back with another way offered') }
      else if (pending.length) { t.state = 'waiting'; logTask(t, `Waiting for your approval (${pending.length})`) }
      else if (t.approvals.some(a => a.answer && !a.settled)) { logTask(t, 'Continuing with your approval decisions') }
      else if (outcome.check && !t.verified && !outcome.unfinished) {
        if (!verifyAttempts.has(id) && !extra?.verification) {
          verifyAttempts.add(id); verifyNext.add(id)
          logTask(t, 'Retrying unresolved result checks once')
        } else { t.state = 'waiting'; logTask(t, 'The report is recorded, but unresolved checks remain. Waiting for your next instruction.') }
      }
      else if (extra?.verification && !outcome.check && !outcome.unfinished) {
        t.state = 'waiting'; t.verified = false; t.verificationIssue = 'The verification turn ended without a result check.'
        logTask(t, t.verificationIssue)
      }
      else if (outcome.unfinished) {
        const reason = (outcome.unfinishedReason || outcome.answer).trim()
        const previous = continuations.get(id)
        if (previous?.reason === reason || (previous?.count ?? 0) >= AUTO_CONTINUE_MAX || /_denied|requires manual control|Blocked by a permission or security screen|권한 또는 보안 화면|sign[ -]in|로그인/i.test(reason)) {
          t.state = 'waiting'
          logTask(t, 'The turn ended with unfinished work; waiting for your next instruction.')
        } else {
          const count = (previous?.count ?? 0) + 1
          continuations.set(id, { count, reason })
          logTask(t, `Continuing unfinished work (${count}/${AUTO_CONTINUE_MAX})`)
        }
      } else { t.state = 'done'; continuations.delete(id); verifyAttempts.delete(id); logTask(t, 'Done') }
    })
    if (after && outcome?.held && after.result) await deps.deliver(channelOf(after), after.result, Date.parse(after.createdAt), trail)
    return after
  }

  const nextReason = (task: DelegatedTask): Reason => task.approvals.some(a => a.answer && !a.settled) ? 'approved' : verifyNext.delete(task.id) ? 'verify' : 'limit'

  async function takeDecisions(task: DelegatedTask): Promise<string> {
    const decided = task.approvals.filter(a => a.answer && !a.settled)
    for (const a of decided) keep(task.id, a)
    approved.set(task.id, decided.filter(a => a.answer === 'approve').map(a => ({ url: a.url, words: a.words })))
    await edit(task.id, t => { for (const a of t.approvals) if (decided.some(d => d.id === a.id)) a.settled = true })
    return decided.map(a => `- ${a.answer !== 'decline' ? 'Approved' : 'Declined'}: "${a.words}" on ${a.host} (${a.url})`).join('\n')
  }

  async function finished(task: DelegatedTask | undefined): Promise<void> {
    if (!task) return
    if (['done', 'failed', 'stopped'].includes(task.state)) { approvalScopes.delete(task.id); alwaysFor.delete(task.id); held.delete(task.id); declined.delete(task.id); approved.delete(task.id); continuations.delete(task.id); verifyAttempts.delete(task.id); verifyNext.delete(task.id) }
    const trail = trails.get(task.id) ?? []
    if (task.state !== 'waiting') trails.delete(task.id)
    if (['done', 'waiting', 'failed'].includes(task.state)) {
      const checkpoint = await readCheckpoint(paths, task.botId)
      taskQueued(task.botId, !!(checkpoint.pending.length))
      try { deps.notify(task) } catch (error) { flog('task-notify', error) }
    }
    if (handedBack.delete(task.id) || task.state !== 'done' || !task.result || task.verificationIssue) return
    await recordPlaybook(paths, task.goal, trail).catch((error) => flog('tasks', error))
    if ((task.work ?? 0) < WORTH_KEEPING_STEPS && !savedFile(task.result)) return
    await deps.remember([`Task finished ${localDay(new Date(task.updatedAt))}: ${task.goal.slice(0, 400)}`, '', 'Result:', task.result.slice(0, 2000)].join('\n'))
      .catch((error) => flog('tasks', error))
  }

  async function carryOn(id: string, reason: Reason, detail = '', heldChannel?: string): Promise<void> {
    if (running.has(id)) return
    running.add(id)
    let channel = heldChannel
    try {
      let why = reason, note = detail
      for (;;) {
        const task = (await listTasks(paths)).find((t) => t.id === id)
        if (!task || !['running', 'queued'].includes(task.state)) return
        channel ??= channelOf(task)
        if (stopped.has(channel)) return
        if (channels.has(channel) && owners.get(channel) !== id) return
        acquire(channel)
        owners.set(channel, id)
        if (why === 'approved' && task.approvals.some(a => a.answer && !a.settled)) note = await takeDecisions(task)
        const history = (await readBotTranscript(paths, task.botId)).map((one) => ({ role: one.role, text: one.text }))
        const after = await turn(id, { engineId: '', botId: task.botId, channel, message: continuationPrompt(task, why, note), history }, { quiet: true, ...(why === 'verify' ? { verification: { result: task.result ?? '' } } : {}) })
        if (after?.state !== 'running') { await finished(after); return }
        why = nextReason(after); note = ''
      }
    } catch (error) {
      const cancelled = !!channel && stopped.has(channel)
      await finished(await edit(id, (t) => { if (t.state === 'running') { t.state = cancelled ? 'stopped' : 'failed'; logTask(t, cancelled ? 'Stopped by you' : `Failed: ${error instanceof Error ? error.message : String(error)}`) } }))
      if (cancelled) return
      if (channel) deps.broadcast({ type: 'chat:error', channel, message: error instanceof Error ? error.message : String(error) })
    } finally { running.delete(id); if (channel && !heldChannel) release(channel); approved.delete(id) }
  }

  return {
    activeChannels: (): string[] => [...channels],
    async chat(request: ChatRequestDto): Promise<void> {
      const botId = request.botId!, channel = `bot-${botId}`
      if (request.channel && request.channel !== channel) throw new Error('The conversation channel does not match.')
      if (channels.has(channel)) throw new Error('This conversation is still working. Stop it or wait for it to finish.')
      acquire(channel)
      stopped.delete(channel)
      let task: DelegatedTask | undefined
      let after: DelegatedTask | undefined
      try {
        const history = (await listTasks(paths)).filter(t => t.botId === botId)
        const active = history.filter(t => ['queued', 'running', 'waiting'].includes(t.state))
        if (active.some((t) => t.state !== 'waiting')) throw new Error('This conversation is still working. Stop it or wait for it to finish.')
        const asked = active.find((t) => t.question)
        const resumed = asked ?? active.find(t => t.approvals.every(a => a.answer))
        if (asked?.question && asked.question !== RESTARTED) deps.learn?.(asked.question, request.message)
        for (const t of active) if (t !== resumed) await edit(t.id, (x) => { approvalScopes.delete(t.id); alwaysFor.delete(t.id); held.delete(t.id); declined.delete(t.id); approved.delete(t.id); x.state = 'stopped'; logTask(x, 'Replaced by a new message') })
        task ??= resumed ?? await createTask(paths, request.message, botId)
        owners.set(channel, task.id)
        const playbook = asked ? undefined : await findPlaybook(paths, request.message, deps.meaning).catch((error) => { flog('tasks', error); return undefined })
        const extra = asked
          ? { context: `This message answers your question in the task below; continue that task with it.\nThe task, verbatim:\n${asked.goal}` }
          : resumed ? { context: `Continue the original task with this new instruction. Inspect the current state before repeating any action.\nOriginal task: ${resumed.goal}` }
          : request.scheduled ? { context: [
            'This is a scheduled task. Start with the saved procedure and its known URLs, or the existing page in this conversation. Do not rediscover the same service with search_web. If no saved route is available, ask_person for the address. If login expired, ask_person to sign in and stop in waiting; do not search for another login page.',
            playbook ? playbookContext(playbook) : '',
          ].filter(Boolean).join('\n\n') }
          : playbook ? { context: playbookContext(playbook) } : undefined
        after = await turn(task.id, { ...request, channel }, extra)
        if (after?.state === 'running') await carryOn(after.id, nextReason(after), '', channel)
        else await finished(after)
      } catch (error) {
        const cancelled = stopped.has(channel)
        if (task) await finished(await edit(task.id, t => { if (t.state === 'running' || t.state === 'queued') { t.state = cancelled ? 'stopped' : 'failed'; logTask(t, cancelled ? 'Stopped by you' : `Failed: ${error instanceof Error ? error.message : String(error)}`) } }))
        if (cancelled) return
        deps.broadcast({ type: 'chat:error', channel, message: error instanceof Error ? error.message : String(error) })
        throw error
      } finally {
        try {
          const checkpoint = await readCheckpoint(paths, botId)
          taskQueued(botId, !!(checkpoint.pending.length))
        } finally { release(channel) }
      }
    },
    stopChannel: async (channel: string): Promise<void> => {
      stopped.add(channel)
      deps.abort(channel)
      for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && ['queued', 'running', 'waiting'].includes(t.state))) {
        approvalScopes.delete(task.id); approved.delete(task.id); alwaysFor.delete(task.id); held.delete(task.id); declined.delete(task.id); trails.delete(task.id)
        await edit(task.id, t => { if (['queued', 'running', 'waiting'].includes(t.state)) { t.state = 'stopped'; logTask(t, 'Stopped by you') } })
      }
    },
    async resume(): Promise<void> {
      const tasks = await listTasks(paths)
      for (const task of tasks) if (['queued', 'running', 'waiting'].includes(task.state)) owners.set(channelOf(task), task.id)
      for (const task of tasksToResume(tasks).filter(t => !channels.has(channelOf(t)))) await edit(task.id, t => {
        t.state = 'waiting'; t.question = RESTARTED
        logTask(t, t.question)
      })
    },
    waitingForPerson: (channel: string): boolean => (waiting.get(channel) ?? 0) > 0,
    askFor(channel: string, confirm: Ask, waitMs = Infinity): Ask | undefined {
      const id = owners.get(channel)
      if (!id || !channels.has(channel)) return undefined
      return async ({ words, url, scope }) => {
        waiting.set(channel, (waiting.get(channel) ?? 0) + 1)
        try {
          const cardWords = url.startsWith('file:') ? words : words.slice(0, 120)
          if (stopped.has(channel) || owners.get(channel) !== id) return 'cancel'
          const current = (await listTasks(paths)).find(t => t.id === id)
          if (current?.state !== 'running') return 'cancel'
          const key = exactKey(url, cardWords)
          if (scope && url.startsWith('engram://app/')) {
            const scopes = approvalScopes.get(id) ?? new Map<string, string>()
            const previous = scopes.get(key)
            if (previous !== scope && (previous || alwaysFor.get(id)?.has(key) || approved.get(id)?.some(g => g.url === url && g.words === cardWords))) {
              alwaysFor.get(id)?.delete(key)
              approved.set(id, (approved.get(id) ?? []).filter(g => g.url !== url || g.words !== cardWords))
              await edit(id, t => { for (const a of t.approvals) if (a.url === url && a.words === cardWords) a.settled = true })
            }
            scopes.set(key, scope); approvalScopes.set(id, scopes)
          }
          let live = current
          for (const until = Date.now() + waitMs; ;) {
            const own = live.approvals.find(a => a.url === url && a.words === cardWords && !a.settled)
            if (!own?.answer) {
              if (refused(live, url, cardWords)) return 'cancel'
              if (covered(live, url, cardWords)) return confirm({ words, url })
              const granted = approved.get(id) ?? []
              const index = granted.findIndex((g) => g.url === url && g.words === cardWords)
              if (index >= 0) { if (!url.startsWith('engram://app/')) granted.splice(index, 1); return confirm({ words, url }) }
            }
            let blockedBy = own ? undefined : blocker(live, url, cardWords)?.id
            let answer: 'approve' | 'approve-task' | 'decline' | undefined
            if (own?.answer || (!own && !blockedBy)) await edit(id, t => {
              if (t.state !== 'running' || stopped.has(channel)) return
              const card = t.approvals.find(a => a.url === url && a.words === cardWords && !a.settled)
              if (card?.answer) { answer = card.answer; card.settled = true; return }
              if (card) return
              if (covered(t, url, cardWords)) { answer = 'approve-task'; return }
              blockedBy = blocker(t, url, cardWords)?.id
              if (!blockedBy) newCard(t, url, cardWords)
            })
            if (answer) {
              if (answer === 'approve' && url.startsWith('engram://app/')) approved.set(id, [...(approved.get(id) ?? []), { url, words: cardWords }])
              keep(id, { url, words: cardWords, answer })
              if (answer === 'decline') refusedThisTurn.add(id)
              return answer !== 'decline' ? confirm({ words, url }) : 'cancel'
            }
            if (Date.now() >= until) { if (blockedBy) hold(id, blockedBy, url, cardWords); return 'later' }
            await new Promise((resolve) => setTimeout(resolve, 1000))
            if (stopped.has(channel) || owners.get(channel) !== id) return 'cancel'
            const next = (await listTasks(paths)).find(t => t.id === id)
            if (next?.state !== 'running') return 'cancel'
            live = next
          }
        } finally {
          const left = (waiting.get(channel) ?? 1) - 1
          if (left) waiting.set(channel, left); else waiting.delete(channel)
        }
      }
    },
    register(): void {
      ipcMain.handle('tasks:list', () => listTasks(paths))
      ipcMain.handle('tasks:decide', async (_e, id: string, approvalId: string, answer: 'approve' | 'approve-task' | 'decline') => {
        if (answer !== 'approve' && answer !== 'approve-task' && answer !== 'decline') throw new Error('Approve or decline.')
        let ready = false
        const task = await edit(id, (t) => {
          if (!['waiting', 'running'].includes(t.state) || t.question || stopped.has(channelOf(t))) return
          const a = t.approvals.find((one) => one.id === approvalId && !one.answer)
          if (!a) return
          a.answer = answer; logTask(t, `${answer !== 'decline' ? 'Approved' : 'Declined'}: "${a.words}"`)
          const follow = (held.get(id)?.get(a.id) ?? []).filter(f => !t.approvals.some(x => !x.settled && x.url === f.url && x.words === f.words))
          held.get(id)?.delete(a.id)
          if (answer !== 'approve-task' && follow.length) { const next = newCard(t, follow[0]!.url, follow[0]!.words); for (const f of follow.slice(1)) hold(id, next, f.url, f.words) }
          if (t.state !== 'waiting') return
          ready = t.approvals.every(one => !!one.answer)
          if (ready) t.state = 'queued'
        })
        if (!task || !ready) return
        void carryOn(id, 'approved').catch(error => flog('tasks', error))
      })
    },
  }
}
