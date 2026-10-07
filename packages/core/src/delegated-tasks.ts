import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { renameWithRetry } from './rename-with-retry.js'
import type { VaultPaths } from './vault.js'

// Work the person handed over and walked away from. Each task lives on disk,
// so it outlasts a turn's limits, a closed window and a restart: the runner
// chains comet turns until the goal is met, and a question or an approval
// waits here for the person instead of in an open dialog.

export type TaskState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

// A press the task wanted to make and did not: the person decides later.
export interface TaskApproval {
  id: string
  words: string
  host: string
  url: string
  at: string
  answer?: 'approve' | 'decline'
  // Answered and handed to the next turn.
  settled?: boolean
}

export interface DelegatedTask {
  id: string
  goal: string
  // The comet the task runs on: its own, so the person's chats stay free.
  botId: string
  state: TaskState
  turns: number
  // Tool steps taken across its turns: how much the task actually did.
  work?: number
  // The one check turn before it is reported done has run.
  verified?: boolean
  // Persists until a check turn finishes, including across questions and restarts.
  verificationPending?: boolean
  verificationAttempts?: number
  verificationIssue?: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
  // What the task asked the person, answered by the next turn.
  question?: string
  approvals: TaskApproval[]
  // The latest answer, and the lines of progress the person sees.
  result?: string
  log: { at: string; line: string }[]
}

// Limits of one delegated task: enough turns for hours of work, never an
// unbounded loop.
export const TASK_MAX_TURNS = 8
export const TASK_MAX_MS = 3 * 60 * 60 * 1000
const LOG_LINES = 60
const KEEP_FINISHED = 100

const file = (paths: VaultPaths) => join(paths.cache, 'tasks.json')

async function readTasks(paths: VaultPaths): Promise<DelegatedTask[]> {
  try {
    const raw = JSON.parse(await readFile(file(paths), 'utf8')) as { tasks?: unknown }
    if (!Array.isArray(raw.tasks) || raw.tasks.some(t => typeof t?.id !== 'string' || typeof t?.goal !== 'string' || typeof t?.botId !== 'string' || !['queued', 'running', 'waiting', 'done', 'failed', 'stopped'].includes(t.state) || !Number.isInteger(t.turns) || t.turns < 0 || !Number.isFinite(Date.parse(t.createdAt)) || !Number.isFinite(Date.parse(t.updatedAt)) || !Array.isArray(t.approvals) || !Array.isArray(t.log))) throw new Error('Invalid saved tasks; the file was preserved.')
    return raw.tasks as DelegatedTask[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function writeTasks(paths: VaultPaths, tasks: DelegatedTask[]): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  const target = file(paths), scratch = `${target}.${process.pid}.tmp`
  await writeFile(scratch, JSON.stringify({ tasks }, null, 2))
  await renameWithRetry(scratch, target)
}

let queue: Promise<unknown> = Promise.resolve()
function mutate<T>(paths: VaultPaths, work: (tasks: DelegatedTask[]) => T): Promise<T> {
  const next = queue.then(async () => {
    const tasks = await readTasks(paths)
    const out = work(tasks)
    const finished = tasks.filter((t) => ['done', 'failed', 'stopped'].includes(t.state))
    const drop = new Set(finished.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(KEEP_FINISHED).map((t) => t.id))
    await writeTasks(paths, tasks.filter((t) => !drop.has(t.id)))
    return out
  })
  queue = next.catch(() => undefined)
  return next
}

export const listTasks = (paths: VaultPaths): Promise<DelegatedTask[]> => readTasks(paths)

export async function createTask(paths: VaultPaths, goal: string, botId: string, now = new Date()): Promise<DelegatedTask> {
  const text = goal.trim()
  if (!text) throw new Error('Say what the task is.')
  const at = now.toISOString()
  const task: DelegatedTask = { id: `t-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`, goal: text, botId, state: 'queued', turns: 0, createdAt: at, updatedAt: at, approvals: [], log: [] }
  return mutate(paths, (tasks) => { tasks.push(task); return task })
}

export function updateTask(paths: VaultPaths, id: string, change: (task: DelegatedTask) => void, now = new Date()): Promise<DelegatedTask | undefined> {
  return mutate(paths, (tasks) => {
    const task = tasks.find((t) => t.id === id)
    if (!task) return undefined
    change(task)
    task.updatedAt = now.toISOString()
    if (['done', 'failed', 'stopped'].includes(task.state)) task.finishedAt ??= task.updatedAt
    task.log = task.log.slice(-LOG_LINES)
    return structuredClone(task)
  })
}

export function logTask(task: DelegatedTask, line: string, now = new Date()): void {
  task.log.push({ at: now.toISOString(), line: line.slice(0, 300) })
}

// After a restart: work that was mid-turn carries on, told to re-observe first.
export function tasksToResume(tasks: DelegatedTask[]): DelegatedTask[] {
  return tasks.filter((t) => t.state === 'running' || t.state === 'queued')
}

// The next message a task's comet receives. The goal travels verbatim every
// time; what came before is in the comet's own conversation.
export function continuationPrompt(task: DelegatedTask, reason: 'limit' | 'restart' | 'answer' | 'approved' | 'verify', detail = ''): string {
  const lead = {
    limit: 'Continue the delegated task where the last turn stopped. Do not repeat work already confirmed; re-read the current state first.',
    restart: 'The app restarted while this delegated task was running. Re-observe the current state before acting, do not repeat confirmed effects, and continue the unfinished work.',
    answer: 'The person answered your question. Continue the delegated task with their answer.',
    approved: 'The person decided on the presses you left for them. Where they approved, make exactly that press now; where they declined, leave it. Then finish the unfinished work.',
    verify: 'Before this task is reported done, check the result against the request below, requirement by requirement. Then reopen each final file and read back each page you changed rather than trusting your earlier answer. Compare names, numbers, dates, counts, formats and limits. Separately audit material factual claims against the original sources and user request, not your own outputs. A request or wish does not establish the current situation or the absence of an existing process; do not strengthen an uncertain status. Remove unsupported claims or clearly mark them as assumptions, proposals or unverified. Fully supplied attachments are already source evidence; partial extraction is not a full read. Correct only mismatches and reread the corrected results; do not redo correct work or press anything new that commits. Finally call report_result_check with requirement checks and a grounding assessment; the host checks the reads itself. Reading a file alone is not a pass. If unresolved, report fail or unknown honestly. Then briefly describe what was checked or remains unverified, with only the final file links.',
  }[reason]
  return [lead, ...(reason === 'verify' ? ['Derive acceptance checks only from the original requested outcomes and constraints, plus correctness or safety conditions necessary to satisfy them. Do not promote optional inspection methods or extra workflows into new requirements; report unperformed scope limitations separately. Keep each check concise.'] : []), ...(detail ? [detail] : []), ...(reason === 'verify' && task.verificationIssue ? [`Previous check did not pass: ${task.verificationIssue}`] : []), '', 'The delegated task, verbatim:', task.goal].join('\n')
}
