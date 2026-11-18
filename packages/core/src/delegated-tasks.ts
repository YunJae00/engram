import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { renameWithRetry } from './rename-with-retry.js'
import type { VaultPaths } from './vault.js'

export const SOURCE_TITLES_RULE = 'A headline or title a source wrote in another language is given in the person\'s language, not quoted in the original; only names of products, companies and people stay as written.'
type TaskState = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

interface TaskApproval {
  id: string
  words: string
  host: string
  url: string
  at: string
  answer?: 'approve' | 'approve-task' | 'decline'
  settled?: boolean
}

export type MemberState = 'hired' | 'working' | 'waiting' | 'reviewing' | 'done' | 'failed' | 'released'
export interface MemberFact { text: string; url: string; site: string; date?: string; listing?: true; rest?: true; name?: string; instead?: string[] }
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DATE_PARTS = /(\d+)\s*(?:[~–-]\s*(\d+)\s*)?(년|월|일)|(?<!\d)(\d{1,4})[./-](\d{1,2})(?:[./-](\d{1,2}))?(?!\d)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})\b/giu
export const dateParts = (text: string): Set<string> => new Set([...text.matchAll(DATE_PARTS)].flatMap(m => {
  const n = (v: string): number => Number(v)
  if (m[3]) return [m[1], m[2]].filter(Boolean).map(v => `${m[3]}${n(v!)}`)
  if (m[7]) return [`월${MONTHS.indexOf(m[7].toLowerCase()) + 1}`, `일${n(m[8]!)}`]
  const [a, b, c] = [m[4]!, m[5]!, m[6]]
  if (!c && a.length < 4 && m[0].includes('.') && !/^[.(]/.test(text.slice(m.index! + m[0].length))) return []
  return c ? [`년${n(a)}`, `월${n(b)}`, `일${n(c)}`] : a.length === 4 ? [`년${n(a)}`, `월${n(b)}`] : [`월${n(a)}`, `일${n(b)}`]
}).concat(/^\s*\d{4}\s*$/.test(text) ? [`년${Number(text.trim())}`] : []))
export const datedText = (f: { text: string; date?: string | undefined }): string => {
  const date = f.date?.trim(), own = dateParts(f.text), parts = [...dateParts(date ?? '')]
  const stated = !date || (parts.length > 0 && parts.every(p => own.has(p)))
  return stated ? f.text : f.text.replace(/([.!?]?)\s*$/u, ` (${date})$1`)
}
export interface MemberData { facts: MemberFact[]; nothing?: { latest?: MemberFact }; items?: string[]; note?: string }
export interface TeamMember { id: string; parentId: string | null; depth: number; role: string; brief: string; botId?: string; background?: true; then?: { botId: string; who: string; brief: string; voice?: string }; voice?: string; deliverable?: string; lookup?: boolean; query?: string; writer?: true; topic?: string; measure?: string; title?: string; state: MemberState; result?: string; files?: string[]; sources?: string[]; shown?: string[]; said?: string; read?: true; empty?: true; late?: true; unfinished?: true; data?: MemberData; review?: { ok: boolean; note: string }; sessionKey: string; hiredAt: string; finishedAt?: string }
export interface TaskTeam { members: TeamMember[]; hires: number; maxHires: number; maxDepth: number; big: boolean; approvedAt?: string; planTurn?: number; lateTold?: true; lateDone?: true; posted?: string[] }
export const TEAM_MAX_HIRES = 8
export const TEAM_MAX_DEPTH = 3
export const MEMBER_RESULT_CHARS = 2000
export const backgroundOpen = (task: DelegatedTask): boolean => (task.team?.members ?? []).some(m => m.background && (m.state === 'hired' || m.state === 'working'))
const MEMBER_STATES = ['hired', 'working', 'waiting', 'reviewing', 'done', 'failed', 'released']
const count = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0
function validTeam(team: Partial<TaskTeam> | null): boolean {
  return !!team && Array.isArray(team.members) && count(team.hires) && count(team.maxHires) && count(team.maxDepth) && typeof team.big === 'boolean' && team.members.every(m =>
    typeof m?.id === 'string' && typeof m.role === 'string' && typeof m.brief === 'string' && typeof m.sessionKey === 'string' && (m.parentId === null || typeof m.parentId === 'string')
    && Number.isInteger(m.depth) && m.depth >= 1 && m.depth <= TEAM_MAX_DEPTH && MEMBER_STATES.includes(m.state) && (m.result === undefined || typeof m.result === 'string' && m.result.length <= MEMBER_RESULT_CHARS)
    && (m.files === undefined || Array.isArray(m.files) && m.files.every(f => typeof f === 'string')) && Number.isFinite(Date.parse(m.hiredAt)))
}

export interface DelegatedTask {
  id: string
  goal: string
  botId: string
  state: TaskState
  turns: number
  tokensUsed?: number
  work?: number
  verified?: boolean
  verificationPending?: boolean
  verificationAttempts?: number
  verificationIssue?: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
  question?: string
  approvals: TaskApproval[]
  result?: string
  log: { at: string; line: string }[]
  unshown?: string
  team?: TaskTeam
  awaitingEmployees?: boolean
}

export const TASK_MAX_TURNS = 50
export const TASK_TOKEN_BUDGET = 300_000
const LOG_LINES = 60
const KEEP_FINISHED = 100

const file = (paths: VaultPaths) => join(paths.cache, 'tasks.json')

async function readTasks(paths: VaultPaths): Promise<DelegatedTask[]> {
  try {
    const raw = JSON.parse(await readFile(file(paths), 'utf8')) as { tasks?: unknown }
    if (!Array.isArray(raw.tasks) || raw.tasks.some(t => typeof t?.id !== 'string' || typeof t?.goal !== 'string' || typeof t?.botId !== 'string' || !['queued', 'running', 'waiting', 'done', 'failed', 'stopped'].includes(t.state) || !Number.isInteger(t.turns) || t.turns < 0 || t.tokensUsed !== undefined && (!Number.isSafeInteger(t.tokensUsed) || t.tokensUsed < 0) || !Number.isFinite(Date.parse(t.createdAt)) || !Number.isFinite(Date.parse(t.updatedAt)) || !Array.isArray(t.approvals) || !Array.isArray(t.log) || t.team !== undefined && !validTeam(t.team))) throw new Error('Invalid saved tasks; the file was preserved.')
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

export function tasksToResume(tasks: DelegatedTask[]): DelegatedTask[] {
  return tasks.filter((t) => t.state === 'running' || t.state === 'queued')
}

export const CHECK_SCRATCH = '.check'

export function continuationPrompt(task: DelegatedTask, reason: 'limit' | 'restart' | 'answer' | 'approved' | 'verify' | 'report', detail = ''): string {
  const lead = {
    limit: 'Continue the delegated task where the last turn stopped. Do not repeat work already confirmed; re-read the current state first.',
    restart: 'The app restarted while this delegated task was running. Re-observe the current state before acting, do not repeat confirmed effects, and continue the unfinished work.',
    answer: 'The person answered your question. Continue the delegated task with their answer.',
    approved: 'The person decided on the presses you left for them. Where they approved, make exactly that press now; where they declined, leave it. Then finish the unfinished work.',
    report: 'The agents on the person\'s team you handed this work to in the background have finished. Give the person their result now, in the person\'s language: short, each part under the name of the agent who did it, with the source addresses kept. Where one agent handed their result to the next, the last result is the deliverable and the earlier one is where its facts came from: keep those facts. Say plainly which part failed and why. ' + SOURCE_TITLES_RULE + ' Call no tools and add no research of your own.',
    verify: 'Before this task is reported done, check the result against the request below, requirement by requirement. When the person\'s own work guide (in what you remember about them) describes this kind of work, its outputs, terms and rules count as part of the request even if the message left them out. Then reopen each final file and read back each page you changed rather than trusting your earlier answer. Sources you already read in full in this task are still in front of you: do not reread them whole; reread only the part needed to confirm a specific claim. Where this task has a work folder with scripts, write one script that compares the final file to the sources and prints every mismatch, run it, fix only what it lists and run it once more; do not keep adding exploratory checks. Compare names, numbers, dates, counts, formats and limits. Separately audit material factual claims against the original sources and user request, not your own outputs. A request or wish does not establish the current situation or the absence of an existing process; do not strengthen an uncertain status. Remove unsupported claims or clearly mark them as assumptions, proposals or unverified. Fully supplied attachments are already source evidence; partial extraction is not a full read. Correct only mismatches and reread the corrected results; do not redo correct work or press anything new that commits. Finally call report_result_check with requirement checks and a grounding assessment; the host checks the reads itself. Reading a file alone is not a pass. Each status is for the result as you hand it over now: a mismatch you corrected and confirmed is a pass, with the correction named in its basis and in your answer; report fail or unknown honestly only for what is still wrong or unconfirmed after your corrections. A rule of the work guide that has nothing to apply to in this result is not_applicable, not unknown: give that guide line word for word as its requirement. Nothing the request itself asks for can be not_applicable. Set reportUnchanged: true in that call only when you changed nothing and every statement in the result below (numbers, names, dates, counts, status, file links) still holds exactly, so the person needs no new report; when anything in it needs correcting, adding or withdrawing, leave reportUnchanged out and state the correction in your answer. Then briefly describe what was checked or remains unverified, with only the final file links.',
  }[reason]
  return [lead, ...(reason === 'verify' && task.result ? ['The result you produced, which the person has not seen yet. Check this result and correct only what is wrong; do not redo the task:', task.result, ''] : []), ...(reason === 'verify' ? [`Write any script or scratch file you make only to check the result (a comparison, a count, a verification run) inside the ${CHECK_SCRATCH}/ folder of your working folder. Do not name or link those files in your answer: a file there is handed to the person only when your answer names it, and every other file you create and name is handed in as a result.`, 'Derive acceptance checks only from the original requested outcomes and constraints, plus correctness or safety conditions necessary to satisfy them. Do not promote optional inspection methods or extra workflows into new requirements; report unperformed scope limitations separately. Keep each check concise.'] : []), ...(detail ? [detail] : []), ...(reason === 'report' ? ['', 'Their reports:', ...(task.team?.members ?? []).filter(m => m.background).map(m => `- ${m.role} [${m.state === 'failed' ? 'failed' : 'done'}]: ${m.result ?? '(nothing)'}`)] : []), ...(reason === 'verify' && task.verificationIssue ? [`Previous check did not pass: ${task.verificationIssue}`] : []), '', 'The delegated task, verbatim:', task.goal].join('\n')
}

export function cometRecord(tasks: DelegatedTask[], botId: string): { confirmed: number; checked: number } {
  const checked = tasks.filter(task => task.botId === botId && (task.verified === true || task.verificationIssue))
  return { confirmed: checked.filter(task => task.verified === true).length, checked: checked.length }
}
