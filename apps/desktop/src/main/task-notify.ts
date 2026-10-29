import { BrowserWindow, Notification } from 'electron'
import type { DelegatedTask } from 'core'
import type { EngramEvent } from '../shared/types.js'

// A task that stops for the person says so outside the window, but only when
// they are not already looking at Engram. Clicking it opens that conversation.

let surface = (): void => undefined
export function setTaskSurface(show: () => void): void { surface = show }
export function surfaceComet(): void { surface() }

// A finished answer is told once the after-turn check has had its say: a job
// it sends back for another pass is told when that pass ends, not before.
const checks = new Map<string, number>()
const held = new Map<string, { tell(): void; timer: NodeJS.Timeout }>()
const HOLD_MS = 15 * 60_000

export function checkStarted(botId: string): void { checks.set(botId, (checks.get(botId) ?? 0) + 1) }
export function checkSettled(botId: string): void {
  const left = (checks.get(botId) ?? 1) - 1
  if (left > 0) { checks.set(botId, left); return }
  checks.delete(botId)
  const notice = held.get(botId)
  if (!notice) return
  held.delete(botId)
  clearTimeout(notice.timer)
  notice.tell()
}

export function notifyTask(task: DelegatedTask, broadcast: (event: EngramEvent) => void): void {
  // A hidden run has nobody watching to tell.
  if (process.env['ENGRAM_HIDDEN'] === '1') return
  if (task.state === 'done' && checks.has(task.botId)) {
    clearTimeout(held.get(task.botId)?.timer)
    const timer = setTimeout(() => checkSettled(task.botId), HOLD_MS)
    held.set(task.botId, { tell: () => tell(task, broadcast), timer })
    return
  }
  tell(task, broadcast)
}

function tell(task: DelegatedTask, broadcast: (event: EngramEvent) => void): void {
  const title = task.state === 'done' ? 'Task done'
    : task.state === 'failed' ? 'Task stopped'
      : task.question ? 'Your answer is needed' : 'Your approval is needed'
  if (BrowserWindow.getFocusedWindow()) { broadcast({ type: 'task:notice', message: title }); return }
  if (!Notification.isSupported()) return
  // Notifications can appear on the lock screen; keep task contents in the app.
  const body = task.state === 'done' ? 'The answer is ready. Click to see it.'
    : task.state === 'failed' ? 'Click to see where it stopped.'
      : task.question ? 'There is a question for you. Click to answer.' : 'A step is waiting for your OK. Click to review it.'
  const note = new Notification({ title, body })
  note.on('click', () => { surface(); broadcast({ type: 'comet:open', botId: task.botId }) })
  note.show()
}
