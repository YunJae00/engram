import { withModelCallContext } from './model-call-metrics.js'
import { changeCheckpoint, readCheckpoint } from './comet-checkpoint.js'
import { taskQueued, discardTaskNotice } from './task-notify.js'
import { ipcMain } from 'electron'
import {
  continuationPrompt,
  successfulTurnSteps,
  createTask,
  findPlaybook,
  hostOf,
  listTasks,
  logTask,
  playbookContext,
  readBotTranscript,
  recordPlaybook,
  TASK_MAX_TURNS,
  cometRecord,
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
import { freshResultReadback, needsResultCheck, RESULT_CHANGES } from './task-result-state.js'


export interface TurnOutcome { answer: string; asked: boolean; unfinished: boolean; steps: number; trail?: TurnStep[]; check?: { accepted: boolean; issues: string[]; report?: Omit<TurnEvidence, 'record'> }; held?: boolean }
export interface TaskTurn { context?: string; quiet?: boolean; verification?: { result: string }; holdIf?: (answer: string, steps: TurnStep[]) => boolean }
type Reason = Parameters<typeof continuationPrompt>[1]
const WORTH_KEEPING_STEPS = 3
const RESTARTED = 'The app restarted during this task. Check any external changes before asking me to continue.'
const UNCONFIRMED = '\n\n⚠ Checked; some of this could not be confirmed against the original.'
const savedFile = (text = '') => /\]\(engram-artifact:/.test(text)
const artifactLinks = (text = '') => [...text.matchAll(/\]\(engram-artifact:([^\s)]+)\)/g)].map((match) => match[1]!)

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
  const automatic = new Set<string>()
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
  const declined = new Map<string, Set<string>>()
  const trails = new Map<string, TurnStep[]>()
  const handedBack = new Set<string>()
  const changed = () => deps.broadcast({ type: 'tasks:changed' })
  const channelOf = (task: DelegatedTask) => `bot-${task.botId}`
  const edit = async (id: string, change: (task: DelegatedTask) => void) => { const task = await updateTask(paths, id, change); changed(); return task }

  async function turn(id: string, request: ChatRequestDto, extra?: TaskTurn): Promise<DelegatedTask | undefined> {
    const started = await edit(id, (t) => {
      if (stopped.has(channelOf(t)) || !['queued', 'running', 'waiting'].includes(t.state)) { t.state = 'stopped'; return }
      if (t.turns >= TASK_MAX_TURNS) {
        t.state = 'failed'; logTask(t, 'Stopped at the task limits before the goal was met.'); return
      }
      t.state = 'running'; delete t.question; t.turns++
    })
    if (!started || started.state !== 'running' || stopped.has(channelOf(started))) {
      if (started?.state === 'failed') deps.broadcast({ type: 'chat:done', channel: channelOf(started), text: started.log.at(-1)?.line ?? 'Task stopped.' })
      return started
    }
    if (extra?.quiet) deps.broadcast({ type: 'comet:continue', channel: channelOf(started), botId: started.botId })
    const checking = started.verificationPending === true
    if (checking) {
      deps.broadcast({ type: 'comet:step', channel: channelOf(started), line: 'note: Checking the result against your request' })
      deps.broadcast({ type: 'chat:token', channel: channelOf(started), text: '', reset: true, drop: true })
    }
    const earlier = trails.get(id) ?? []
    const holdIf = (answer: string, steps: TurnStep[]) => !started.verified && needsResultCheck(answer, [...earlier, ...steps])
    let overran = false, checkError: unknown
    let budget: ReturnType<typeof setTimeout> | undefined
    const deadline = checking && deps.checkBudgetMs ? new Promise<void>(resolve => {
      budget = setTimeout(() => { overran = true; deps.abort(channelOf(started)); resolve() }, deps.checkBudgetMs)
    }) : undefined
    try {
      const sending = withModelCallContext({ channel: channelOf(started), task: id, turn: started.turns, purpose: checking ? 'verify' : request.previouslySaid ? 'automatic-continuation' : 'task' }, () => deps.send(request, checking ? { ...extra, verification: { result: started.result ?? '' }, context: [extra?.context, continuationPrompt(started, 'verify')].filter(Boolean).join('\n\n') } : { ...extra, holdIf }))
      await (deadline ? Promise.race([sending, deadline]) : sending)
    } catch (error) {
      if (!checking) throw error
      checkError = error
    } finally { clearTimeout(budget) }
    const outcome = overran || checkError ? undefined : deps.outcome(request.channel ?? '')
    const trail = [...earlier, ...(outcome?.trail ?? [])]
    trails.set(id, trail)
    const after = await edit(id, (t) => {
      if (t.state !== 'running') return
      t.work = (t.work ?? 0) + (outcome?.steps ?? 0)
      const draft = t.result
      if (outcome && !checking) t.result = outcome.answer
      const pending = t.approvals.filter((a) => !a.answer)
      if (!outcome && checking) {
        delete t.verificationPending
        t.verificationIssue = overran ? 'The check ran out of time.' : 'The check could not finish.'
        t.result = `${draft ?? ''}${UNCONFIRMED} ${t.verificationIssue}`
        t.state = 'done'; logTask(t, `Done, not fully confirmed: ${t.verificationIssue}`)
      }
      else if (!outcome) { t.state = 'failed'; logTask(t, 'The turn ended without an answer.') }
      else if (outcome.asked) { t.state = 'waiting'; t.question = outcome.answer; logTask(t, 'Waiting for your answer') }
      else if (!checking && deps.offered?.(channelOf(t))) { handedBack.add(t.id); t.state = 'done'; logTask(t, 'Handed back with another way offered') }
      else if (pending.length) { t.state = 'waiting'; logTask(t, `Waiting for your approval (${pending.length})`) }
      else if (t.approvals.some(a => a.answer && !a.settled)) { logTask(t, 'Continuing with your approval decisions') }
      else if (checking) {
        const steps = outcome.trail ?? []
        const reread = freshResultReadback(steps)
        delete t.verificationPending
        if (!outcome.unfinished && reread && outcome.check?.accepted === true) {
          t.verified = true; delete t.verificationIssue
          t.result = outcome.answer
          t.state = 'done'; logTask(t, 'Done')
        } else {
          t.verificationIssue = outcome.check?.issues.join('; ') || (outcome.unfinished ? 'The check ended before the results were confirmed.' : reread ? 'The check reported no structured result.' : 'The check needs a fresh readback after the last change.')
          const corrected = successfulTurnSteps(steps).some(step => RESULT_CHANGES.test(step.tool) || step.committed) || artifactLinks(outcome.answer).some((link) => !artifactLinks(draft).includes(link))
          t.result = `${corrected || !draft ? outcome.answer : draft}${UNCONFIRMED} ${t.verificationIssue.replace(/\s+/g, ' ')}`
          t.state = 'done'; logTask(t, `Done, not fully confirmed: ${t.verificationIssue}`)
        }
      } else if (outcome.unfinished) {
        if (t.turns >= TASK_MAX_TURNS) { t.state = 'failed'; logTask(t, 'Stopped at the task limits before the goal was met.') }
        else logTask(t, 'Continuing')
      } else if (!t.verified && needsResultCheck(outcome.answer, trail)) {
        t.verificationPending = true; logTask(t, 'Checking the result')
      } else { t.state = 'done'; logTask(t, 'Done') }
    })
    if (after && (outcome?.held || (checking && !outcome)) && ['done', 'waiting', 'failed'].includes(after.state) && after.result) {
      const report = outcome?.check?.report
      await deps.deliver(channelOf(after), after.result, Date.parse(after.createdAt), trail, report && {
        ...report,
        grounding: after.verified === true ? report.grounding : { status: 'unknown', basis: after.verificationIssue || 'The result was not confirmed.' },
        record: cometRecord(await listTasks(paths), after.botId),
      })
    }
    return after
  }

  const nextReason = (task: DelegatedTask): Reason => task.approvals.some(a => a.answer && !a.settled) ? 'approved' : task.verificationPending ? 'verify' : 'limit'

  async function takeDecisions(task: DelegatedTask): Promise<string> {
    const decided = task.approvals.filter(a => a.answer && !a.settled)
    approved.set(task.id, decided.filter(a => a.answer === 'approve').map(a => ({ url: a.url, words: a.words })))
    for (const a of decided) if (a.answer === 'decline') declined.set(task.id, (declined.get(task.id) ?? new Set()).add(`${a.url}\n${a.words}`))
    await edit(task.id, t => { for (const a of t.approvals) if (decided.some(d => d.id === a.id)) a.settled = true })
    return decided.map(a => `- ${a.answer === 'approve' ? 'Approved' : 'Declined'}: "${a.words}" on ${a.host} (${a.url})`).join('\n')
  }

  async function finished(task: DelegatedTask | undefined): Promise<void> {
    if (!task) return
    const trail = trails.get(task.id) ?? []
    if (task.state !== 'waiting') trails.delete(task.id)
    if (!automatic.has(task.id) && ['done', 'waiting', 'failed'].includes(task.state)) {
      const checkpoint = await readCheckpoint(paths, task.botId)
      taskQueued(task.botId, !!(checkpoint.pending.length || checkpoint.returned?.length))
      try { deps.notify(task) } catch (error) { flog('task-notify', error) }
    }
    if (handedBack.delete(task.id) || task.state !== 'done' || !task.result || task.verificationIssue) return
    await recordPlaybook(paths, task.goal, trail).catch((error) => flog('tasks', error))
    if ((task.work ?? 0) < WORTH_KEEPING_STEPS && !savedFile(task.result)) return
    await deps.remember([`Task finished ${task.updatedAt.slice(0, 10)}: ${task.goal.slice(0, 400)}`, '', 'Result:', task.result.slice(0, 2000)].join('\n'))
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
        const after = await turn(id, { engineId: '', botId: task.botId, channel, message: continuationPrompt(task, why, note), history }, { quiet: true })
        if (after?.state !== 'running') { await finished(after); return }
        why = nextReason(after); note = ''
      }
    } catch (error) {
      await finished(await edit(id, (t) => { if (t.state === 'running') { t.state = 'failed'; logTask(t, `Failed: ${error instanceof Error ? error.message : String(error)}`) } }))
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
        if (request.previouslySaid) {
          const previous = history.at(-1)
          let repeated = false
          await changeCheckpoint(paths, botId, state => {
            repeated = (state.replayed ?? []).includes(request.message)
            return { ...state, returned: (state.returned ?? []).filter(text => text !== request.message),
              replayed: [...new Set([...(state.replayed ?? []), request.message])],
              pending: state.pending.filter(text => text !== request.message) }
          })
          discardTaskNotice(botId)
          if (asked || repeated || !previous || ['waiting', 'stopped', 'failed'].includes(previous.state) || previous.turns >= TASK_MAX_TURNS) {
            deps.broadcast({ type: 'chat:steer-unapplied', channel, texts: [request.message] })
            deps.broadcast({ type: 'chat:done', channel, text: asked?.question ?? previous?.result ?? '' })
            return
          }
          task = previous
          automatic.add(task.id)
          await edit(task.id, t => { t.state = 'queued'; delete t.verified; logTask(t, 'Continuing with previously supplied instructions') })
          await changeCheckpoint(paths, botId, state => ({ ...state, pending: [...new Set([...state.pending, request.message])] }))
        } else {
          await changeCheckpoint(paths, botId, state => ({ ...state, returned: [], replayed: [] }))
          if (asked?.question && asked.question !== RESTARTED) deps.learn?.(asked.question, request.message)
          if (history.at(-1)?.goal.trim() === request.message.trim()) flog('tasks', 'The person explicitly repeated the previous goal')
        }
        for (const t of active) if (t !== asked) await edit(t.id, (x) => { x.state = 'stopped'; logTask(x, 'Replaced by a new message') })
        task ??= asked ?? await createTask(paths, request.message, botId)
        owners.set(channel, task.id)
        const playbook = asked || request.previouslySaid ? undefined : await findPlaybook(paths, request.message, deps.meaning).catch((error) => { flog('tasks', error); return undefined })
        const extra = request.previouslySaid
          ? { context: `These instructions were supplied during the same task. Continue that task without treating them as an answer to a later question.\nOriginal task: ${task.goal}` }
          : asked
          ? { context: `This message answers your question in the task below; continue that task with it.\nThe task, verbatim:\n${asked.goal}` }
          : request.scheduled ? { context: [
            'This is a scheduled task. Start with the saved procedure and its known URLs, or the existing page in this conversation. Do not rediscover the same service with search_web. If no saved route is available, ask_person for the address. If login expired, ask_person to sign in and stop in waiting; do not search for another login page.',
            playbook ? playbookContext(playbook) : '',
          ].filter(Boolean).join('\n\n') }
          : playbook ? { context: playbookContext(playbook) } : undefined
        after = await turn(task.id, { ...request, channel }, extra)
        if (after?.state === 'running') await carryOn(after.id, nextReason(after), '', channel)
        else await finished(after)
      } catch (error) {
        if (task) await finished(await edit(task.id, t => { if (t.state === 'running' || t.state === 'queued') { t.state = 'failed'; logTask(t, `Failed: ${error instanceof Error ? error.message : String(error)}`) } }))
        deps.broadcast({ type: 'chat:error', channel, message: error instanceof Error ? error.message : String(error) })
        throw error
      } finally {
        if (task) automatic.delete(task.id)
        try {
          const checkpoint = await readCheckpoint(paths, botId)
          taskQueued(botId, !!(checkpoint.pending.length || checkpoint.returned?.length))
        } finally { release(channel) }
      }
    },
    stopChannel: async (channel: string): Promise<void> => {
      stopped.add(channel)
      deps.abort(channel)
      for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && ['queued', 'running', 'waiting'].includes(t.state))) {
        approved.delete(task.id); trails.delete(task.id)
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
      return async ({ words, url }) => {
        waiting.set(channel, (waiting.get(channel) ?? 0) + 1)
        try {
          const cardWords = url.startsWith('file:') ? words : words.slice(0, 120)
          if (stopped.has(channel) || owners.get(channel) !== id) return 'cancel'
          const current = (await listTasks(paths)).find(t => t.id === id)
          if (current?.state !== 'running') return 'cancel'
          const granted = approved.get(id) ?? []
          const index = granted.findIndex((g) => g.url === url && g.words === cardWords)
          if (index >= 0) { granted.splice(index, 1); return confirm({ words, url }) }
          if (declined.get(id)?.has(`${url}\n${cardWords}`)) return 'cancel'
          await edit(id, (t) => {
            if (t.state !== 'running' || stopped.has(channel) || t.approvals.some((a) => !a.settled && a.url === url && a.words === cardWords)) return
            t.approvals.push({ id: `a-${Date.now().toString(36)}-${t.approvals.length}`, words: cardWords, host: hostOf(url) ?? '', url, at: new Date().toISOString() })
          })
          for (const until = Date.now() + waitMs; Date.now() < until;) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
            if (stopped.has(channel) || owners.get(channel) !== id) return 'cancel'
            const live = (await listTasks(paths)).find(t => t.id === id)
            if (live?.state !== 'running') return 'cancel'
            if (!live.approvals.some(a => a.url === url && a.words === cardWords && a.answer && !a.settled)) continue
            let answer: 'approve' | 'decline' | undefined
            await edit(id, t => {
              if (t.state !== 'running' || stopped.has(channel)) return
              const card = t.approvals.find(a => a.url === url && a.words === cardWords && a.answer && !a.settled)
              if (card) { answer = card.answer; card.settled = true }
            })
            if (!answer) continue
            if (answer === 'decline') declined.set(id, (declined.get(id) ?? new Set()).add(`${url}\n${cardWords}`))
            return answer === 'approve' ? confirm({ words, url }) : 'cancel'
          }
          return 'later'
        } finally {
          const left = (waiting.get(channel) ?? 1) - 1
          if (left) waiting.set(channel, left); else waiting.delete(channel)
        }
      }
    },
    register(): void {
      ipcMain.handle('tasks:list', () => listTasks(paths))
      ipcMain.handle('tasks:decide', async (_e, id: string, approvalId: string, answer: 'approve' | 'decline') => {
        if (answer !== 'approve' && answer !== 'decline') throw new Error('Approve or decline.')
        let ready = false
        const task = await edit(id, (t) => {
          if (!['waiting', 'running'].includes(t.state) || t.question || stopped.has(channelOf(t))) return
          const a = t.approvals.find((one) => one.id === approvalId && !one.answer)
          if (!a) return
          a.answer = answer; logTask(t, `${answer === 'approve' ? 'Approved' : 'Declined'}: "${a.words}"`)
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
