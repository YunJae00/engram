import { BrowserWindow, Notification } from 'electron'
import type { DelegatedTask } from 'core'
import type { EngramEvent } from '../shared/types.js'
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
export function discardTaskNotice(botId: string): void {
  clearTimeout(held.get(botId)?.timer); held.delete(botId)
}
const HOLD_MS = 15 * 60_000
// Notifications can appear on the lock screen; the words never carry task contents.
const WORDS = {
  en: { paused: ['Task paused', 'The unfinished result is ready. Click to continue with an instruction.'], done: ['Task done', 'The answer is ready. Click to see it.'], failed: ['Task stopped', 'Click to see what got done and what is left.'], question: ['Your answer is needed', 'There is a question for you. Click to answer.'], approval: ['Your approval is needed', 'A step is waiting for your OK. Click to review it.'] },
  ko: { paused: ['작업을 잠시 멈췄어요', '중간 결과가 있어요. 눌러서 어떻게 이어갈지 알려 주세요.'], done: ['작업을 마쳤어요', '답이 준비됐어요. 눌러서 확인해 보세요.'], failed: ['작업이 멈췄어요', '눌러서 한 일과 남은 일을 확인해 보세요.'], question: ['답이 필요해요', '여쭤볼 게 있어요. 눌러서 답해 주세요.'], approval: ['확인이 필요해요', '진행 전에 확인할 단계가 있어요. 눌러서 살펴봐 주세요.'] },
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
export function noticeText(task: Pick<DelegatedTask, 'state' | 'goal' | 'question' | 'approvals'>, transcript: Said = []): readonly [string, string] {
  const paused = task.state === 'waiting' && !task.question && !task.approvals.some(approval => !approval.answer)
  return WORDS[closingLang(transcript, task.goal)][paused ? 'paused' : task.state === 'done' ? 'done' : task.state === 'failed' ? 'failed' : task.question ? 'question' : 'approval']
}

export function notifyTask(task: DelegatedTask, broadcast: (event: EngramEvent) => void, level?: string, transcript: Said = []): void {
  // A hidden run has nobody watching to tell.
  if (process.env['ENGRAM_HIDDEN'] === '1') return
  if (task.state === 'done' && (queued.has(task.botId) || clientQueues.has(task.botId))) {
    clearTimeout(held.get(task.botId)?.timer)
    const timer = setTimeout(() => flushNotice(task.botId), HOLD_MS)
    held.set(task.botId, { tell: () => tell(task, broadcast, level, transcript), timer })
    return
  }
  tell(task, broadcast, level, transcript)
}

function tell(task: DelegatedTask, broadcast: (event: EngramEvent) => void, level: string | undefined, transcript: Said): void {
  if (task.state === 'done' && task.id) {
    if (notified.has(task.id)) return
    notified.add(task.id)
  }
  const paused = task.state === 'waiting' && !task.question && !task.approvals.some(approval => !approval.answer)
  const [title, body] = noticeText(task, transcript)
  // A person looking at Engram sees the task in its conversation already.
  if (BrowserWindow.getFocusedWindow()) return
  if (level === 'off' || (level === 'attention' && task.state !== 'failed' && (task.state !== 'waiting' || paused))) return
  if (!Notification.isSupported()) return
  const note = new Notification({ title, body })
  note.on('click', () => { surface(); broadcast({ type: 'comet:open', botId: task.botId }) })
  note.show()
}
