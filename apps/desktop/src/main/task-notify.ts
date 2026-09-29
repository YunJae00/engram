import { BrowserWindow, Notification } from 'electron'
import type { DelegatedTask } from 'core'
import type { EngramEvent } from '../shared/types.js'

// A task that stops for the person says so outside the window, but only when
// they are not already looking at Engram. Clicking it opens that conversation.

let surface = (): void => undefined
export function setTaskSurface(show: () => void): void { surface = show }

export function notifyTask(task: DelegatedTask, broadcast: (event: EngramEvent) => void): void {
  // A hidden run has nobody watching to tell.
  if (process.env['ENGRAM_HIDDEN'] === '1') return
  const title = task.state === 'done' ? 'Task done'
    : task.state === 'failed' ? 'Task stopped'
      : task.question ? 'Your answer is needed' : 'Your approval is needed'
  if (BrowserWindow.getFocusedWindow()) { broadcast({ type: 'task:notice', message: title }); return }
  if (!Notification.isSupported()) return
  // Notifications can appear on the lock screen; keep task contents in the app.
  const note = new Notification({ title, body: 'Open Engram to review this task.' })
  note.on('click', () => { surface(); broadcast({ type: 'comet:open', botId: task.botId }) })
  note.show()
}
