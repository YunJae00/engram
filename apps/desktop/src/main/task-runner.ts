import { withModelCallContext } from './model-call-metrics.js'
import { lendingSlot } from './worker-pool.js'
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
  routineCardExpired,
  TASK_MAX_TURNS,
  TASK_TOKEN_BUDGET, teamReviewIssue, teamUnverified,
  tasksToResume,
  updateTask,
  withoutReplies,
  withoutSecrets,
  type DelegatedTask,
  type MeaningScores,
  successfulTurnSteps,
  type ReviewRule,
  type TurnStep,
  type VaultPaths,
} from 'core'
import type { ChatRequestDto, EngramEvent } from '../shared/types.js'
import type { TurnEvidence } from 'core'
import type { Ask } from './page-actions.js'
import { flog } from './flog.js'
import { READ_CARD } from './read-card.js'
import { changedResult, freshResultReadback, nothingToReadBack, RESULT_CHANGES } from './task-result-state.js'
import { allowedByRule, readRules, reviewAction } from './review-gate.js'
import { closeTask, ENDED_LOG, isRestartQuestion, restartQuestion, type ClosingReason } from './task-closing.js'


// The files an answer hands over, by the name the person knows (a saved copy carries an id before it).
const handedOver = (text: string): string => [...new Set([...text.matchAll(/\]\(engram-artifact:([^\s)]+)\)/g)].map(match => match[1]!.replace(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i, '')))].sort().join('\n')

const plain = (text: string) => text.replace(/\r\n?/g, '\n').trim()
/** True only when a re-check answer is the delivered report again, character for character: only the line-ending style (CRLF/CR) and
 *  whitespace around the whole text are set aside. Nothing inside is folded, so anything else is posted, once: 10⁶ is not 106, two
 *  commands on two lines are not one command, a changed comma can reverse a report, ~~strikethrough~~ withdraws a claim, and a saved
 *  copy's id tells two versions of report.md apart.
 *  The host's own reading beside the model's reportUnchanged; unsure means post. */
export function recheckAddsNothing(answer: string, report: string): boolean {
  return plain(answer) === plain(report)
}

export interface TurnOutcome { tokensUsed?: number; budgetExhausted?: boolean; answer: string; asked: boolean; unfinished: boolean; unfinishedReason?: string; steps: number; trail?: TurnStep[]; check?: { accepted: boolean; verified?: boolean; issues: string[]; /** Handed-in files this turn never read back in full. */ readbacks?: { name: string; path: string }[]; report?: Omit<TurnEvidence, 'record'>; /** The re-check's own word that the delivered report needs no correction. */ reportUnchanged?: boolean }; held?: boolean; /** The turn ended on a provider error the thread already shows. */ errored?: string }
export interface TaskTurn { tokenBudget?: number; context?: string; quiet?: boolean; verification?: { result: string; /** A readback-only follow-up: every file linked in result is held to its readback, whatever the answer links. */ readback?: boolean}; holdIf?: (answer: string, steps: TurnStep[], check?: { accepted: boolean; verified?: boolean; issues?: string[] }) => boolean }
type Reason = Parameters<typeof continuationPrompt>[1]
// The one follow-up a check turn gets when all it lacks is the readback of files the host handed in after its report.
const readbackPrompt = (task: DelegatedTask, files: { name: string; path: string }[]): string => [
  'Your result check passed except for one thing: these files were handed in with the result, but were not read back in full after their last write.',
  ...files.map(file => `- ${file.name}: ${file.path}`),
  'Read each of them in full with file_read, every page to the end, and reopen in full every other final file linked in the result below: only what this turn reads counts. Then call report_result_check again (reportUnchanged: true when nothing in the result needs correcting) and answer with the result below unchanged, keeping its file links.',
  'The requirement checks you already reported stand as they are: this turn adds only the readbacks and cannot drop, replace or re-pass a check.',
  'Do no other work: do not edit, create, rerun or re-derive anything. If a readback shows the result is wrong, report that check as failed and say exactly what differs instead of fixing it.',
  '', 'The result:', task.result ?? '', '', 'The delegated task, verbatim:', task.goal].join('\n')
const AUTO_CONTINUE_MAX = 3
const WORTH_KEEPING_STEPS = 3
const savedFile = (text = '') => /\]\(engram-artifact:/.test(text)
const exactKey = (url: string, words: string) => `${url}\n${words}`
// Command approvals (file:) share one kind per host and sandbox side; every other url keeps its exact key.
// A file read card (#read, file-work.ts) is for that one file: approving it for the task covers only that file.
const kindOf = (url: string, words: string): string => {
  if (!url.startsWith('file:')) return exactKey(url, words)
  try { const u = new URL(url); return u.hash === READ_CARD ? exactKey(url, words) : `file://${u.host}${u.hash ? '#' : ''}` } catch { return exactKey(url, words) }
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
  learn?(question: string, answer: string, goal: string): void
  notify(task: DelegatedTask): void
  offered?(channel: string): boolean
  meaning?: MeaningScores
  reviewRules?: () => Promise<readonly ReviewRule[]>
  now?: () => number
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
  // Tasks created by a scheduled routine in this app session; their unanswered cards expire.
  const routine = new Set<string>()
  const trails = new Map<string, TurnStep[]>()
  const handedBack = new Set<string>()
  const continuations = new Map<string, { count: number; reason: string }>()
  const verifyAttempts = new Set<string>()
  const verifyNext = new Set<string>()
  // A check turn that lacked only handed-in files' readbacks gets one readback-only turn; these are its files, and the tasks that already had theirs.
  const readbackNext = new Map<string, { name: string; path: string }[]>()
  const readbackAttempts = new Set<string>()
  // The model's own verdicts in the last turn's result check, to tell a confirming re-check from a correcting one.
  const verdicts = new Map<string, NonNullable<TurnOutcome['check']>['report']>()
  // A held answer the runner has not posted because its own re-check follows at once: posted when that re-check adds nothing, replaced when it
  // answers anew, and never lost when the task ends any other way (flush).
  const unshown = new Map<string, string>()
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
  // Every end the person did not ask for leaves a closing message in the thread (task-closing.ts).
  const close = (task: DelegatedTask | undefined, reason: ClosingReason, channel = task && channelOf(task), error?: unknown, goal = task?.goal) => closeTask(paths, deps.broadcast, { task, reason, channel, trail: task ? trails.get(task.id) : undefined, error, goal })

  const flush = async (task: DelegatedTask | undefined): Promise<void> => {
    const draft = task && unshown.get(task.id)
    if (!task || draft === undefined) return
    unshown.delete(task.id)
    await deps.deliver(channelOf(task), draft, Date.parse(task.createdAt), trails.get(task.id) ?? [])
  }

  async function turn(id: string, request: ChatRequestDto, extra?: TaskTurn): Promise<DelegatedTask | undefined> {
    const started = await edit(id, (t) => {
      if (stopped.has(channelOf(t)) || !['queued', 'running', 'waiting'].includes(t.state)) { t.state = 'stopped'; return }
      if ((t.tokensUsed ?? 0) >= TASK_TOKEN_BUDGET || t.turns >= TASK_MAX_TURNS) {
        t.state = 'failed'; logTask(t, 'Stopped at the task budget or fallback turn limit.'); return
      }
      t.state = 'running'; delete t.question; delete t.verified; delete t.verificationIssue; t.turns++
    })
    if (!started || started.state !== 'running' || stopped.has(channelOf(started))) {
      if (started?.state === 'failed') await close(started, (started.tokensUsed ?? 0) >= TASK_TOKEN_BUDGET ? 'budget' : 'turn-limit')
      return started
    }
    if (extra?.quiet) deps.broadcast({ type: 'comet:continue', channel: channelOf(started), botId: started.botId })
    const earlier = trails.get(id) ?? []
    refusedThisTurn.delete(id)
    // The answers this runner re-checks before calling the task done (see the branches below): a team's report, and a result whose own check is not clean, once.
    const holdIf: TaskTurn['holdIf'] = (answer, steps, check) => !extra?.verification && (check ? !verifyAttempts.has(id) && !(check.accepted && check.verified !== false && !check.issues?.length && (freshResultReadback(steps) || nothingToReadBack(answer, [...earlier, ...steps]))) : !!started.team?.members.length || successfulTurnSteps(steps).some(step => step.tool === 'hire_members'))
    await withModelCallContext({ channel: channelOf(started), task: id, turn: started.turns, purpose: 'task' }, () => deps.send(request, { ...extra, holdIf, tokenBudget: Math.max(0, TASK_TOKEN_BUDGET - (started.tokensUsed ?? 0)) }))
    const refused = refusedThisTurn.delete(id)
    approved.set(id, (approved.get(id) ?? []).filter(grant => !grant.url.startsWith('engram://app/')))
    const outcome = deps.outcome(request.channel ?? '')
    const trail = [...earlier, ...(outcome?.trail ?? [])]
    trails.set(id, trail)
    const reported = verdicts.get(id)
    // The report a verification turn re-checks, when that report's own check passed every requirement and its grounding: only then can it stand without this turn.
    const recheckOf = extra?.verification?.result.trim() && reported && [...reported.checks, reported.grounding].every(one => one.status === 'pass') ? extra.verification.result : ''
    const after = await edit(id, (t) => {
      if (t.state !== 'running') return
      if (stopped.has(channelOf(t))) { t.state = 'stopped'; logTask(t, 'Stopped by you'); return }
      t.tokensUsed = (t.tokensUsed ?? 0) + Math.max(0, outcome?.tokensUsed ?? 0)
      t.work = (t.work ?? 0) + (outcome?.steps ?? 0)
      if (outcome) t.result = outcome.answer
      if (outcome?.check) {
        t.verified = outcome.check.accepted && outcome.check.verified !== false && outcome.check.issues.length === 0 && !outcome.unfinished && !outcome.budgetExhausted && (freshResultReadback(outcome.trail ?? []) || nothingToReadBack(outcome.answer, trail)) && !teamReviewIssue(t)
        if (!t.verified) t.verificationIssue = [...outcome.check.issues, teamReviewIssue(t)].filter(Boolean).join('; ') || 'The result has no fresh readback.'
        else delete t.verificationIssue
        // The readback-only follow-up may only read: one that changed a result is not accepted, whatever it then read. No second follow-up is given, so the task ends waiting.
        if (extra?.verification?.readback && changedResult(outcome.trail ?? [])) { t.verified = false; t.verificationIssue = 'The readback-only turn changed the result instead of only reading it back, so its check was not accepted.' }
      }
      delete t.verificationPending
      const pending = t.approvals.filter((a) => !a.answer)
      if (!outcome) { t.state = 'failed'; logTask(t, ENDED_LOG) }
      else if (outcome.errored) { t.state = 'failed'; logTask(t, `Failed: ${outcome.errored}`) }
      // A re-check that ran out of budget leaves the report it was re-checking as the result: that report is in the thread and its own check passed every
      // requirement, so the task is finished with it rather than failed at the limit (qa143 S19: a 9-page report ended "처리 한도에 닿아 끝나지 않았어요").
      else if (outcome.budgetExhausted && recheckOf) { t.result = recheckOf; t.state = 'done'; continuations.delete(id); logTask(t, 'Done; the re-check stopped at the task token budget.') }
      else if (outcome.budgetExhausted) { t.state = 'failed'; logTask(t, 'Stopped at the task token budget.') }
      else if (outcome.asked) { t.state = 'waiting'; t.question = outcome.answer; logTask(t, 'Waiting for your answer') }
      else if (refused && (outcome.unfinished || (outcome.check && !t.verified))) { t.state = 'waiting'; logTask(t, 'You declined a command, so this turn stopped. Waiting for your next instruction.') }
      else if (deps.offered?.(channelOf(t)) && !outcome.unfinished && !pending.length && (!outcome.check || t.verified) && !teamUnverified(t)) { handedBack.add(t.id); t.state = 'done'; logTask(t, 'Handed back with another way offered') }
      else if (pending.length) { t.state = 'waiting'; logTask(t, `Waiting for your approval (${pending.length})`) }
      else if (t.approvals.some(a => a.answer && !a.settled)) { logTask(t, 'Continuing with your approval decisions') }
      else if (outcome.check && !t.verified && !outcome.unfinished) {
        const unread = outcome.check.readbacks ?? []
        if (!verifyAttempts.has(id) && !extra?.verification) {
          verifyAttempts.add(id); verifyNext.add(id)
          logTask(t, 'Retrying unresolved result checks once')
        } else if (unread.length && unread.length === outcome.check.issues.length && !teamReviewIssue(t) && !readbackAttempts.has(id)) {
          // Every check passed and the only issues are final bytes nobody read: one bounded turn to read them, never a pass without it.
          readbackAttempts.add(id); readbackNext.set(id, unread)
          logTask(t, 'Reading back the handed-in files once')
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
      } else if (!outcome.answer.trim()) { t.state = 'failed'; logTask(t, ENDED_LOG) } else if (teamUnverified(t)) { verifyNext.add(id); logTask(t, 'Checking the team deliverable before reporting done') } else { t.state = 'done'; continuations.delete(id); verifyAttempts.delete(id); logTask(t, 'Done') }
    })
    // One finished task, one report: a re-check stays silent only when it says itself (reportUnchanged) that the report already in the thread
    // needs no correction; without that word it is posted, since a readback can correct a statement without touching a file.
    // It is also posted when it changed something, hands over other files, or passes a requirement the delivered report's own check had left failed or unknown.
    // That word alone is not trusted: the host also reads the answer, and posts it unless it is that report again (recheckAddsNothing).
    // A readback-only follow-up does not re-judge requirements: the check turn's own report is carried over unchanged, whatever checks the follow-up reports.
    if (!extra?.verification?.readback) verdicts.set(id, outcome?.check?.report)
    const repeats = !!extra?.verification?.result.trim() && after?.state === 'done' && outcome?.check?.reportUnchanged === true && !successfulTurnSteps(outcome?.trail ?? []).some(step => RESULT_CHANGES.test(step.tool))
      && !(reported && [...reported.checks, reported.grounding].some(one => one.status !== 'pass')) && handedOver(after.result ?? '') === handedOver(extra.verification.result) && recheckAddsNothing(after.result ?? '', extra.verification.result)
    const kept = !!outcome?.budgetExhausted && !!recheckOf && after?.state === 'done'
    if (after && outcome?.held && after.result) {
      // A re-check that only confirmed (or ran out of budget on) a report still unposted posts that report; one already in the thread is not posted again.
      if (repeats || kept) await flush(after)
      // Held for the re-check that starts now: that turn's answer is the one posted.
      else if (!extra?.verification && after.state === 'running' && verifyNext.has(id)) unshown.set(id, after.result)
      else { unshown.delete(id); await deps.deliver(channelOf(after), after.result, Date.parse(after.createdAt), trail) }
    } else if (after && after.state !== 'running') await flush(after)
    // An error the thread already shows gets no "say continue" closing: continuing cannot fix it.
    if (after?.state === 'failed' && !outcome?.errored && (!outcome || outcome.budgetExhausted || !outcome.answer.trim())) await close(after, outcome?.budgetExhausted ? 'budget' : 'empty')
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
    await flush(task)
    if (['done', 'failed', 'stopped'].includes(task.state)) { approvalScopes.delete(task.id); alwaysFor.delete(task.id); routine.delete(task.id); held.delete(task.id); declined.delete(task.id); approved.delete(task.id); continuations.delete(task.id); verifyAttempts.delete(task.id); verifyNext.delete(task.id); verdicts.delete(task.id); readbackNext.delete(task.id); readbackAttempts.delete(task.id) }
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
    await deps.remember([`Task finished ${localDay(new Date(task.updatedAt))}: ${withoutSecrets(task.goal, task.goal).slice(0, 400)}`, '', 'Result:', withoutSecrets(withoutReplies(task.result), task.goal).slice(0, 2000)].join('\n'))
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
        const history = (await readBotTranscript(paths, task.botId)).filter(one => !one.error).map((one) => ({ role: one.role, text: one.text }))
        const unread = readbackNext.get(id)
        readbackNext.delete(id)
        const after = await turn(id, { engineId: '', botId: task.botId, channel, message: unread ? readbackPrompt(task, unread) : continuationPrompt(task, why, note), history }, { quiet: true, ...(why === 'verify' || unread ? { verification: { result: task.result ?? '', ...(unread ? { readback: true } : {}) } } : {}) })
        if (after?.state !== 'running') { await finished(after); return }
        why = nextReason(after); note = ''
      }
    } catch (error) {
      const cancelled = !!channel && stopped.has(channel)
      const after = await edit(id, (t) => { if (t.state === 'running') { t.state = cancelled ? 'stopped' : 'failed'; logTask(t, cancelled ? 'Stopped by you' : `Failed: ${error instanceof Error ? error.message : String(error)}`) } })
      await flush(after)
      if (!cancelled) await close(after, 'error', channel, error)
      await finished(after)
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
        if (asked?.question && !isRestartQuestion(asked.question)) deps.learn?.(asked.question, request.message, asked.goal)
        for (const t of active) if (t !== resumed) await edit(t.id, (x) => { approvalScopes.delete(t.id); alwaysFor.delete(t.id); routine.delete(t.id); held.delete(t.id); declined.delete(t.id); approved.delete(t.id); x.state = 'stopped'; logTask(x, 'Replaced by a new message') })
        task ??= resumed ?? await createTask(paths, request.message, botId)
        if (task !== resumed && request.scheduled === true) routine.add(task.id)
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
        const failed = task ? await edit(task.id, t => { if (t.state === 'running' || t.state === 'queued') { t.state = cancelled ? 'stopped' : 'failed'; logTask(t, cancelled ? 'Stopped by you' : `Failed: ${error instanceof Error ? error.message : String(error)}`) } }) : undefined
        await flush(failed)
        if (!cancelled) await close(failed, 'error', channel, error, request.message)
        await finished(failed)
        if (cancelled) return
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
        approvalScopes.delete(task.id); approved.delete(task.id); alwaysFor.delete(task.id); routine.delete(task.id); held.delete(task.id); declined.delete(task.id); trails.delete(task.id)
        await edit(task.id, t => { if (['queued', 'running', 'waiting'].includes(t.state)) { t.state = 'stopped'; logTask(t, 'Stopped by you') } })
      }
    },
    async resume(): Promise<void> {
      const tasks = await listTasks(paths)
      for (const task of tasks) if (['queued', 'running', 'waiting'].includes(task.state)) owners.set(channelOf(task), task.id)
      for (const task of tasksToResume(tasks).filter(t => !channels.has(channelOf(t)))) {
        const question = await restartQuestion(paths, task)
        await edit(task.id, t => { t.state = 'waiting'; t.question = question; logTask(t, 'The app restarted during this task.') })
      }
    },
    waitingForPerson: (channel: string): boolean => (waiting.get(channel) ?? 0) > 0,
    askFor(channel: string, confirm: Ask, waitMs = Infinity): Ask | undefined {
      const id = owners.get(channel)
      if (!id || !channels.has(channel)) return undefined
      return lendingSlot(async ({ words, url, scope }) => {
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
          let rules: readonly ReviewRule[] | undefined
          const refresh = async () => stopped.has(channel) || owners.get(channel) !== id ? undefined : (await listTasks(paths)).find(t => t.id === id && t.state === 'running')
          for (const until = Date.now() + waitMs; ;) {
            const own = live.approvals.find(a => a.url === url && a.words === cardWords && !a.settled)
            if (!own?.answer) {
              if (refused(live, url, cardWords)) return 'cancel'
              if (covered(live, url, cardWords)) return confirm({ words, url })
              const granted = approved.get(id) ?? []
              const index = granted.findIndex((g) => g.url === url && g.words === cardWords)
              if (index >= 0) { if (!url.startsWith('engram://app/')) granted.splice(index, 1); return confirm({ words, url }) }
              if (!own && reviewAction(url)) {
                // The read awaits outside code, so a card or decision made meanwhile is seen before the rules apply.
                if (!rules) { rules = await readRules(deps.reviewRules); const next = await refresh(); if (!next) return 'cancel'; live = next; continue }
                if (allowedByRule(rules, url)) return confirm({ words, url })
              }
            }
            if (own && !own.answer && routine.has(id) && routineCardExpired(own.at, (deps.now ?? Date.now)())) {
              let expired = false
              await edit(id, t => {
                const card = t.approvals.find(a => a.id === own.id && !a.answer && !a.settled)
                if (!card || t.state !== 'running' || stopped.has(channel)) return
                card.answer = 'decline'; card.settled = true; expired = true
                logTask(t, 'Approval card expired after 30 minutes')
              })
              if (expired) { keep(id, { url, words: cardWords, answer: 'decline' }); refusedThisTurn.add(id); return 'cancel' }
              const next = await refresh(); if (!next) return 'cancel'; live = next; continue
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
            const next = await refresh()
            if (!next) return 'cancel'
            live = next
          }
        } finally {
          const left = (waiting.get(channel) ?? 1) - 1
          if (left) waiting.set(channel, left); else waiting.delete(channel)
        }
      }) as Ask
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
