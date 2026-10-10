import { ipcMain } from 'electron'
import {
  continuationPrompt,
  createTask,
  findPlaybook,
  hostOf,
  listTasks,
  logTask,
  playbookContext,
  readBotTranscript,
  recordPlaybook,
  successfulTurnSteps,
  TASK_MAX_MS,
  TASK_MAX_TURNS,
  tasksToResume,
  updateTask,
  type DelegatedTask,
  type TurnStep,
  type VaultPaths,
} from 'core'
import type { ChatRequestDto, EngramEvent } from '../shared/types.js'
import type { Ask } from './page-actions.js'
import { flog } from './flog.js'
import { freshResultReadback, RESULT_CHANGES as CHANGES } from './task-result-state.js'

// Every comet message is a task: its first turn is the ordinary chat turn the
// person watches, and when that turn stops short of the goal the work goes on
// by itself, turn after turn, until it is done, needs an answer or an
// approval, or reaches its limits. A press that would commit something is not
// made unattended: it waits in the task, and the rest of the work goes on.

export interface TurnOutcome { answer: string; asked: boolean; unfinished: boolean; steps: number; trail?: TurnStep[]; check?: { accepted: boolean; issues: string[] }; held?: boolean }
// How the host runs one of the task's turns: extra context, and whether the
// message is the task's own continuation rather than words the person said.
// holdIf: the host keeps this turn's answer out of the thread when it says so (work that will be checked first).
export interface TaskTurn { context?: string; quiet?: boolean; verification?: { result: string }; holdIf?: (answer: string, steps: TurnStep[]) => boolean }
type Reason = Parameters<typeof continuationPrompt>[1]
// Work worth writing down: several tool steps, or a saved file.
const WORTH_KEEPING_STEPS = 3
const RESTARTED = 'The app restarted during this task. Check any external changes before asking me to continue.'
const UNCONFIRMED = '\n\n⚠ Checked; some of this could not be confirmed against the original.'
const CHECK_BUDGET_MS = 10 * 60_000
const savedFile = (text = '') => /\]\(engram-artifact:/.test(text)
const artifactLinks = (text = '') => [...text.matchAll(/\]\(engram-artifact:([^\s)]+)\)/g)].map((match) => match[1]!)
// Captures already have consent, provenance and save receipts; this text and
// document check must not demand a text read of a PNG or retake a recording.
const savedWorkFile = (text = '') => /\]\(engram-artifact:[^\s)]+\.(?:txt|md|json|csv|tsv|xlsx|docx|pptx)\)/i.test(text)

export function taskRunner(deps: {
  paths: VaultPaths
  send(request: ChatRequestDto, turn?: TaskTurn): Promise<void>
  outcome(channel: string): TurnOutcome | undefined
  abort(channel: string): void
  broadcast(event: EngramEvent): void
  remember(text: string): Promise<void>
  // A held answer, put in the thread once: after its check, or when the task stops for the person.
  // since: when the task began, for finding revisions saved during it.
  deliver(channel: string, text: string, since: number): Promise<void>
  // How long a check may hold the answer back before the draft goes out as it is.
  checkBudgetMs?: number
  // The person answered what a comet asked: what holds beyond this task is kept.
  learn?(question: string, answer: string): void
  // The task stopped for the person: done, waiting on them, or failed.
  notify(task: DelegatedTask): void
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
  // The task each comet is working on, by channel; presses the person
  // approved, each good for one press; presses they declined, never asked again.
  const owners = new Map<string, string>()
  const approved = new Map<string, { url: string; words: string }[]>()
  const declined = new Map<string, Set<string>>()
  // Each task's steps across its turns, and tasks whose next turn is the check.
  const trails = new Map<string, TurnStep[]>()
  const changed = () => deps.broadcast({ type: 'tasks:changed' })
  const channelOf = (task: DelegatedTask) => `bot-${task.botId}`
  const edit = async (id: string, change: (task: DelegatedTask) => void) => { const task = await updateTask(paths, id, change); changed(); return task }

  // One turn, then where the task stands: running (keep going), waiting, done or failed.
  async function turn(id: string, request: ChatRequestDto, extra?: TaskTurn): Promise<DelegatedTask | undefined> {
    const started = await edit(id, (t) => {
      if (stopped.has(channelOf(t)) || !['queued', 'running', 'waiting'].includes(t.state)) { t.state = 'stopped'; return }
      if (t.turns >= TASK_MAX_TURNS || Date.now() - Date.parse(t.createdAt) > TASK_MAX_MS) {
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
      // The draft stays out of the thread while it is checked: one answer, once it is done.
      deps.broadcast({ type: 'chat:token', channel: channelOf(started), text: '', reset: true })
    }
    const earlier = trails.get(id) ?? []
    const holdIf = (answer: string, steps: TurnStep[]) => !started.verified && (savedWorkFile(answer) || successfulTurnSteps([...earlier, ...steps]).some((step) => CHANGES.test(step.tool)))
    // A check that overruns its budget is cut short: the draft is the answer then.
    let overran = false, checkError: unknown
    let budget: ReturnType<typeof setTimeout> | undefined
    const deadline = checking ? new Promise<void>(resolve => {
      budget = setTimeout(() => { overran = true; deps.abort(channelOf(started)); resolve() }, deps.checkBudgetMs ?? CHECK_BUDGET_MS)
    }) : undefined
    try {
      const sending = deps.send(request, checking ? { ...extra, verification: { result: started.result ?? '' }, context: [extra?.context, continuationPrompt(started, 'verify')].filter(Boolean).join('\n\n') } : { ...extra, holdIf })
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
        t.result = `${draft ?? ''}${UNCONFIRMED}`
        t.state = 'done'; logTask(t, `Done, not fully confirmed: ${t.verificationIssue}`)
      }
      else if (!outcome) { t.state = 'failed'; logTask(t, 'The turn ended without an answer.') }
      else if (outcome.asked) { t.state = 'waiting'; t.question = outcome.answer; logTask(t, 'Waiting for your answer') }
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
          // One check, and the person gets the answer either way: what the
          // check corrected if it saved anything new, else the draft, with what
          // could not be confirmed kept here rather than in the thread.
          t.verificationIssue = outcome.check?.issues.join('; ') || (outcome.unfinished ? 'The check ended before the results were confirmed.' : reread ? 'The check reported no structured result.' : 'The check needs a fresh readback after the last change.')
          const corrected = artifactLinks(outcome.answer).some((link) => !artifactLinks(draft).includes(link))
          t.result = `${corrected || !draft ? outcome.answer : draft}${UNCONFIRMED}`
          t.state = 'done'; logTask(t, `Done, not fully confirmed: ${t.verificationIssue}`)
        }
      } else if (outcome.unfinished) {
        if (t.turns >= TASK_MAX_TURNS || Date.now() - Date.parse(t.createdAt) > TASK_MAX_MS) { t.state = 'failed'; logTask(t, 'Stopped at the task limits before the goal was met.') }
        else logTask(t, 'Continuing')
      } else if (!t.verified && (savedWorkFile(outcome.answer) || successfulTurnSteps(trail).some((step) => CHANGES.test(step.tool)))) {
        t.verificationPending = true; logTask(t, 'Checking the result')
      } else { t.state = 'done'; logTask(t, 'Done') }
    })
    if (after && (outcome?.held || (checking && !outcome)) && ['done', 'waiting', 'failed'].includes(after.state) && after.result) await deps.deliver(channelOf(after), after.result, Date.parse(after.createdAt))
    return after
  }

  // Why the next unattended turn runs.
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
    // A task waiting on the person resumes later; its steps so far still count.
    if (task.state !== 'waiting') trails.delete(task.id)
    if (['done', 'waiting', 'failed'].includes(task.state)) {
      try { deps.notify(task) } catch (error) { flog('task-notify', error) }
    }
    // A result the check could not confirm is kept for the person, not learned from.
    if (task.state !== 'done' || !task.result || task.verificationIssue) return
    await recordPlaybook(paths, task.goal, trail).catch((error) => flog('tasks', error))
    if ((task.work ?? 0) < WORTH_KEEPING_STEPS && !savedFile(task.result)) return
    await deps.remember([`Task finished ${task.updatedAt.slice(0, 10)}: ${task.goal.slice(0, 400)}`, '', 'Result:', task.result.slice(0, 2000)].join('\n'))
      .catch((error) => flog('tasks', error))
  }

  // Turns the person does not type: the thread shows them as the same work going on.
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
    // The person's message to a comet: an answer to what the comet asked, or new work.
    async chat(request: ChatRequestDto): Promise<void> {
      const botId = request.botId!, channel = `bot-${botId}`
      if (request.channel && request.channel !== channel) throw new Error('The conversation channel does not match.')
      if (channels.has(channel)) throw new Error('This conversation is still working. Stop it or wait for it to finish.')
      acquire(channel)
      stopped.delete(channel)
      let task: DelegatedTask | undefined
      let after: DelegatedTask | undefined
      try {
        const active = (await listTasks(paths)).filter((t) => t.botId === botId && ['queued', 'running', 'waiting'].includes(t.state))
        if (active.some((t) => t.state !== 'waiting')) throw new Error('This conversation is still working. Stop it or wait for it to finish.')
        const asked = active.find((t) => t.question)
        if (asked?.question && asked.question !== RESTARTED) deps.learn?.(asked.question, request.message)
        for (const t of active) if (t !== asked) await edit(t.id, (x) => { x.state = 'stopped'; logTask(x, 'Replaced by a new message') })
        task = asked ?? await createTask(paths, request.message, botId)
        owners.set(channel, task.id)
        // New work starts from how a similar task was done, when one was.
        const playbook = asked ? undefined : await findPlaybook(paths, request.message).catch((error) => { flog('tasks', error); return undefined })
        const extra = asked
          ? { context: `This message answers your question in the task below; continue that task with it.\nThe task, verbatim:\n${asked.goal}` }
          : playbook ? { context: playbookContext(playbook) } : undefined
        after = await turn(task.id, { ...request, channel }, extra)
        if (after?.state === 'running') await carryOn(after.id, nextReason(after), '', channel)
        else await finished(after)
      } catch (error) {
        if (task) await finished(await edit(task.id, t => { if (t.state === 'running' || t.state === 'queued') { t.state = 'failed'; logTask(t, `Failed: ${error instanceof Error ? error.message : String(error)}`) } }))
        deps.broadcast({ type: 'chat:error', channel, message: error instanceof Error ? error.message : String(error) })
        throw error
      } finally { release(channel) }
    },
    stopChannel: async (channel: string): Promise<void> => {
      stopped.add(channel)
      deps.abort(channel)
      for (const task of (await listTasks(paths)).filter(t => channelOf(t) === channel && ['queued', 'running', 'waiting'].includes(t.state))) {
        approved.delete(task.id); trails.delete(task.id)
        await edit(task.id, t => { if (['queued', 'running', 'waiting'].includes(t.state)) { t.state = 'stopped'; logTask(t, 'Stopped by you') } })
      }
    },
    // A crashed turn may already have committed an effect. Never replay it unattended.
    async resume(): Promise<void> {
      const tasks = await listTasks(paths)
      for (const task of tasks) if (['queued', 'running', 'waiting'].includes(task.state)) owners.set(channelOf(task), task.id)
      for (const task of tasksToResume(tasks).filter(t => !channels.has(channelOf(t)))) await edit(task.id, t => {
        t.state = 'waiting'; t.question = RESTARTED
        logTask(t, t.question)
      })
    },
    // The question a press would put to the person becomes an approval
    // waiting in the task, one per page and control; the turn goes on.
    // waitMs: how long a call may hold for the card's answer before taking 'later'.
    askFor(channel: string, confirm: Ask, waitMs = 0): Ask | undefined {
      const id = owners.get(channel)
      if (!id || !channels.has(channel)) return undefined
      return async ({ words, url }) => {
        const cardWords = words.slice(0, 120)
        if (stopped.has(channel) || owners.get(channel) !== id) return 'cancel'
        const current = (await listTasks(paths)).find(t => t.id === id)
        if (current?.state !== 'running') return 'cancel'
        const granted = approved.get(id) ?? []
        const index = granted.findIndex((g) => g.url === url && g.words === cardWords)
        // The form may have changed since the card was created. Reconfirm on
        // the live page rather than authorizing arbitrary data at the same URL.
        if (index >= 0) { granted.splice(index, 1); return confirm({ words, url }) }
        if (declined.get(id)?.has(`${url}\n${cardWords}`)) return 'cancel'
        await edit(id, (t) => {
          if (t.state !== 'running' || stopped.has(channel) || t.approvals.some((a) => !a.settled && a.url === url && a.words === cardWords)) return
          t.approvals.push({ id: `a-${Date.now().toString(36)}-${t.approvals.length}`, words: cardWords, host: hostOf(url) ?? '', url, at: new Date().toISOString() })
        })
        // The person may be right there: the card can be answered while the turn runs.
        for (const until = Date.now() + waitMs; Date.now() < until;) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          if (stopped.has(channel) || owners.get(channel) !== id) return 'cancel'
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
