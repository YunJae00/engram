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

// Every comet message is a task: its first turn is the ordinary chat turn the
// person watches, and when that turn stops short of the goal the work goes on
// by itself, turn after turn, until it is done, needs an answer or an
// approval, or reaches its limits. A press that would commit something is not
// made unattended: it waits in the task, and the rest of the work goes on.

export interface TurnOutcome { answer: string; asked: boolean; unfinished: boolean; steps: number; trail?: TurnStep[] }
// How the host runs one of the task's turns: extra context, and whether the
// message is the task's own continuation rather than words the person said.
export interface TaskTurn { context?: string; quiet?: boolean }
type Reason = Parameters<typeof continuationPrompt>[1]
// Work worth writing down: several tool steps, or a saved file.
const WORTH_KEEPING_STEPS = 3
// Steps that change something outside the conversation: a task that took one
// rereads its result once before it is called done.
const CHANGES = /^(page_steps|press|press_key|press_point|type_text|choose|upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package)$/
// A read receipt is necessary, not proof that every requirement was satisfied.
const READBACK = /^(read_open_page|read_pages|look|verify|read_desktop|look_desktop|read_live_document|file_read|file_read_package|file_read_workbook|excel_read|word_read|ppt_read)$/
const savedFile = (text = '') => /\]\(engram-artifact:/.test(text)

export function taskRunner(deps: {
  paths: VaultPaths
  send(request: ChatRequestDto, turn?: TaskTurn): Promise<void>
  outcome(channel: string): TurnOutcome | undefined
  abort(channel: string): void
  broadcast(event: EngramEvent): void
  remember(text: string): Promise<void>
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
    if (checking) deps.broadcast({ type: 'comet:step', channel: channelOf(started), line: 'note: Checking the result against your request' })
    await deps.send(request, checking ? { ...extra, context: [extra?.context, continuationPrompt(started, 'verify')].filter(Boolean).join('\n\n') } : extra)
    const outcome = deps.outcome(request.channel ?? '')
    const trail = [...(trails.get(id) ?? []), ...(outcome?.trail ?? [])]
    trails.set(id, trail)
    return edit(id, (t) => {
      if (t.state !== 'running') return
      t.work = (t.work ?? 0) + (outcome?.steps ?? 0)
      if (outcome && !checking) t.result = outcome.answer
      const pending = t.approvals.filter((a) => !a.answer)
      if (!outcome) { t.state = 'failed'; logTask(t, 'The turn ended without an answer.') }
      else if (outcome.asked) { t.state = 'waiting'; t.question = outcome.answer; logTask(t, 'Waiting for your answer') }
      else if (pending.length) { t.state = 'waiting'; logTask(t, `Waiting for your approval (${pending.length})`) }
      else if (outcome.unfinished) {
        if (t.turns >= TASK_MAX_TURNS || Date.now() - Date.parse(t.createdAt) > TASK_MAX_MS) { t.state = 'failed'; logTask(t, 'Stopped at the task limits before the goal was met.') }
        else logTask(t, 'Continuing')
      } else if (checking) {
        const receipts = successfulTurnSteps(outcome.trail ?? [])
        const lastChange = receipts.map(step => CHANGES.test(step.tool)).lastIndexOf(true)
        if (!receipts.some((step, i) => i > lastChange && READBACK.test(step.tool))) {
          logTask(t, 'Verification still needs a fresh readback after the last change.')
        } else {
          t.verified = true; delete t.verificationPending
          t.result = [t.result, `Checked: ${outcome.answer}`].filter(Boolean).join('\n\n')
          t.state = 'done'; logTask(t, 'Done')
        }
      } else if (!t.verified && (savedFile(outcome.answer) || successfulTurnSteps(trail).some((step) => CHANGES.test(step.tool)))) {
        t.verificationPending = true; logTask(t, 'Checking the result')
      } else { t.state = 'done'; logTask(t, 'Done') }
    })
  }

  // Why the next unattended turn runs.
  const nextReason = (task: DelegatedTask): Reason => task.verificationPending ? 'verify' : 'limit'

  async function finished(task: DelegatedTask | undefined): Promise<void> {
    if (!task) return
    const trail = trails.get(task.id) ?? []
    // A task waiting on the person resumes later; its steps so far still count.
    if (task.state !== 'waiting') trails.delete(task.id)
    if (['done', 'waiting', 'failed'].includes(task.state)) {
      try { deps.notify(task) } catch (error) { flog('task-notify', error) }
    }
    if (task.state !== 'done' || !task.result) return
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
        t.state = 'waiting'; t.question = 'The app restarted during this task. Check any external changes before asking me to continue.'
        logTask(t, t.question)
      })
    },
    // The question a press would put to the person becomes an approval
    // waiting in the task, one per page and control; the turn goes on.
    askFor(channel: string, confirm: Ask): Ask | undefined {
      const id = owners.get(channel)
      if (!id || !channels.has(channel)) return undefined
      return async ({ words, url }) => {
        if (stopped.has(channel) || owners.get(channel) !== id) return 'cancel'
        const current = (await listTasks(paths)).find(t => t.id === id)
        if (current?.state !== 'running') return 'cancel'
        const granted = approved.get(id) ?? []
        const index = granted.findIndex((g) => g.url === url && g.words === words)
        // The form may have changed since the card was created. Reconfirm on
        // the live page rather than authorizing arbitrary data at the same URL.
        if (index >= 0) { granted.splice(index, 1); return confirm({ words, url }) }
        if (declined.get(id)?.has(`${url}\n${words}`)) return 'cancel'
        await edit(id, (t) => {
          if (t.approvals.some((a) => !a.answer && a.url === url && a.words === words)) return
          t.approvals.push({ id: `a-${Date.now().toString(36)}-${t.approvals.length}`, words: words.slice(0, 120), host: hostOf(url) ?? '', url, at: new Date().toISOString() })
        })
        return 'later'
      }
    },
    register(): void {
      ipcMain.handle('tasks:list', () => listTasks(paths))
      ipcMain.handle('tasks:decide', async (_e, id: string, approvalId: string, answer: 'approve' | 'decline') => {
        if (answer !== 'approve' && answer !== 'decline') throw new Error('Approve or decline.')
        let ready = false
        const task = await edit(id, (t) => {
          if (t.state !== 'waiting' || t.question || stopped.has(channelOf(t))) return
          const a = t.approvals.find((one) => one.id === approvalId && !one.answer)
          if (!a) return
          a.answer = answer; logTask(t, `${answer === 'approve' ? 'Approved' : 'Declined'}: "${a.words}"`)
          ready = t.approvals.every(one => !!one.answer)
          if (ready) t.state = 'queued'
        })
        if (!task || !ready) return
        const decided = task.approvals.filter((a) => a.answer && !a.settled)
        approved.set(id, decided.filter((a) => a.answer === 'approve').map((a) => ({ url: a.url, words: a.words })))
        for (const a of decided) if (a.answer === 'decline') declined.set(id, (declined.get(id) ?? new Set()).add(`${a.url}\n${a.words}`))
        const summary = decided.map((a) => `- ${a.answer === 'approve' ? 'Approved' : 'Declined'}: "${a.words}" on ${a.host} (${a.url})`).join('\n')
        await edit(id, (t) => { for (const a of t.approvals) if (a.answer) a.settled = true })
        void carryOn(id, 'approved', summary).catch(error => flog('tasks', error))
      })
    },
  }
}
