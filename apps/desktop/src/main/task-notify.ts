import { BrowserWindow, Notification } from 'electron'
import { listTasks, loadBots, readBotTranscript, type DelegatedTask, type TeamMember, type VaultPaths } from 'core'
import type { EngramEvent } from '../shared/types.js'
import { awayReady, vaultIo } from './away-summary.js'
import { flog } from './flog.js'
import { closingLang } from './task-closing.js'

// A task that stops for the person says so outside the window, but only when
// they are not already looking at Engram. Clicking it opens that conversation.

let surface = (): void => undefined
export function setTaskSurface(show: () => void): void { surface = show }
export function surfaceComet(): void { surface() }

const held = new Map<string, { tell(): void; timer: NodeJS.Timeout }>()
const queued = new Set<string>()
const notified = new Set<string>()
const clientQueues = new Map<string, Set<number>>()
export function clientTaskQueued(botId: string, pending: boolean, source = 0): void {
  const sources = clientQueues.get(botId) ?? new Set<number>()
  if (pending) sources.add(source)
  else sources.delete(source)
  if (sources.size) clientQueues.set(botId, sources)
  else { clientQueues.delete(botId); flushNotice(botId) }
}
export function clearClientTaskQueues(source: number): void {
  for (const [botId, sources] of clientQueues) if (sources.has(source)) clientTaskQueued(botId, false, source)
}

export function taskQueued(botId: string, pending: boolean): void {
  if (pending) queued.add(botId)
  else { queued.delete(botId); flushNotice(botId) }
}
const HOLD_MS = 15 * 60_000
// Notifications can appear on the lock screen; the words never carry task contents.
const WORDS = {
  en: { paused: ['Progress so far', 'The unfinished result is ready. Click to continue with an instruction.'], done: ['Done', 'The answer is ready. Click to see it.'], failed: ['Stopped', 'Click to see what got done and what is left.'], question: ['Needs your answer', 'There is a question for you. Click to answer.'], approval: ['Needs your OK', 'A step is waiting for your OK. Click to review it.'] },
  ko: { paused: ['여기까지 했어요', '중간 결과가 있어요. 눌러서 어떻게 이어갈지 알려 주세요.'], done: ['다 했어요', '답이 준비됐어요. 눌러서 확인해 보세요.'], failed: ['멈췄어요', '눌러서 한 일과 남은 일을 확인해 보세요.'], question: ['답이 필요해요', '여쭤볼 게 있어요. 눌러서 답해 주세요.'], approval: ['확인이 필요해요', '진행 전에 확인할 단계가 있어요. 눌러서 살펴봐 주세요.'] },
} as const

function flushNotice(botId: string): void {
  if (queued.has(botId) || clientQueues.has(botId)) return
  const notice = held.get(botId)
  if (!notice) return
  held.delete(botId)
  clearTimeout(notice.timer)
  notice.tell()
}

type Said = readonly { role: string; text: string }[]
const label = (name?: string): string => (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Engram'
export function noticeText(task: Pick<DelegatedTask, 'state' | 'goal' | 'question' | 'approvals'>, transcript: Said = [], name?: string): readonly [string, string] {
  const paused = task.state === 'waiting' && !task.question && !task.approvals.some(approval => !approval.answer)
  const [title, body] = WORDS[closingLang(transcript, task.goal)][paused ? 'paused' : task.state === 'done' ? 'done' : task.state === 'failed' ? 'failed' : task.question ? 'question' : 'approval']
  return [`${label(name)}: ${title}`, body]
}

export function notifyTask(task: DelegatedTask, broadcast: (event: EngramEvent) => void, level?: string, transcript: Said = [], name?: string): void {
  // A hidden run has nobody watching to tell.
  if (process.env['ENGRAM_HIDDEN'] === '1') return
  if (task.state === 'done' && (queued.has(task.botId) || clientQueues.has(task.botId))) {
    clearTimeout(held.get(task.botId)?.timer)
    const timer = setTimeout(() => flushNotice(task.botId), HOLD_MS)
    held.set(task.botId, { tell: () => tell(task, broadcast, level, transcript, name), timer })
    return
  }
  tell(task, broadcast, level, transcript, name)
}

function tell(task: DelegatedTask, broadcast: (event: EngramEvent) => void, level: string | undefined, transcript: Said, name?: string): void {
  if (task.state === 'done' && task.id) {
    if (notified.has(task.id)) return
    notified.add(task.id)
  }
  const paused = task.state === 'waiting' && !task.question && !task.approvals.some(approval => !approval.answer)
  const [title, body] = noticeText(task, transcript, name)
  // A person looking at Engram sees the task in its conversation already.
  if (BrowserWindow.getFocusedWindow()) return
  if (level === 'off' || (level === 'attention' && task.state !== 'failed' && (task.state !== 'waiting' || paused))) return
  if (!Notification.isSupported()) return
  const note = new Notification({ title, body })
  note.on('click', () => { surface(); broadcast({ type: 'comet:open', botId: task.botId }) })
  note.show()
}

const MILESTONE_MS = 10 * 60_000
// Lead-hired members already counted per task, and when each task last showed a milestone.
const reported = new Map<string, Set<string>>()
const milestoneAt = new Map<string, number>()
const hasReported = (m: TeamMember): boolean => m.state === 'done' || m.state === 'released' && !m.result?.startsWith('Failed:')
interface BotVoice { name: string | undefined; level: string | undefined; transcript: Said }

// A member handing its part to the lead is progress worth a word on a long job, at most once per ten minutes per task.
export async function teamReported(tasks: readonly DelegatedTask[], voice: (botId: string) => Promise<BotVoice>, broadcast: (event: EngramEvent) => void, now = Date.now()): Promise<void> {
  for (const task of tasks) {
    if (task.state === 'done' || task.state === 'failed' || task.state === 'stopped') { reported.delete(task.id); milestoneAt.delete(task.id); continue }
    if (!task.team) continue
    const lead = task.team.members.filter(m => m.parentId === null), done = lead.filter(hasReported)
    const known = reported.get(task.id)
    reported.set(task.id, new Set([...(known ?? []), ...done.map(m => m.id)]))
    // First sight after a start only primes the count, so a restart announces nothing old.
    if (!known) continue
    const fresh = done.filter(m => !known.has(m.id))
    if (!fresh.length || task.state !== 'running' || process.env['ENGRAM_HIDDEN'] === '1' || BrowserWindow.getFocusedWindow()) continue
    if (now - (milestoneAt.get(task.id) ?? -Infinity) < MILESTONE_MS || !Notification.isSupported()) continue
    milestoneAt.set(task.id, now)
    const v = await voice(task.botId).catch((error: unknown) => { milestoneAt.delete(task.id); throw error })
    if (v.level === 'off' || v.level === 'attention' || BrowserWindow.getFocusedWindow()) continue
    // A member's role can carry the assignment itself, so the lock screen gets only the count.
    const ko = closingLang(v.transcript, task.goal) === 'ko'
    const note = new Notification({ title: `${label(v.name)}: ${WORDS[ko ? 'ko' : 'en'].paused[0]}`, body: `${ko ? '팀원 끝' : 'Team member finished'} (${done.length}/${lead.length})` })
    note.on('click', () => { surface(); broadcast({ type: 'comet:open', botId: task.botId }) })
    note.show()
  }
}

export function taskNotices(paths: VaultPaths, broadcast: (event: EngramEvent) => void): { task(task: DelegatedTask): void; team(): void } {
  const voice = async (botId: string): Promise<BotVoice> => {
    const bot = await loadBots(paths).then(bots => bots.find(one => one.id === botId), () => undefined)
    return { name: bot?.name, level: bot?.notify, transcript: await readBotTranscript(paths, botId, 40).catch(() => []) }
  }
  awayReady(vaultIo(paths), () => broadcast({ type: 'notices:changed' }))
  return {
    task: task => { void voice(task.botId).then(v => notifyTask(task, broadcast, v.level, v.transcript, v.name)).catch(error => flog('task-notify', error)) },
    team: () => { void listTasks(paths).then(all => teamReported(all, voice, broadcast)).catch(error => flog('task-notify', error)) },
  }
}
