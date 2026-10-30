import { beforeEach, expect, it, vi } from 'vitest'
import type { DelegatedTask } from 'core'

const mocks = vi.hoisted(() => ({ supported: true, focused: false, show: vi.fn(), click: undefined as (() => void) | undefined }))
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => mocks.focused ? {} : null },
  Notification: class {
    static isSupported() { return mocks.supported }
    on(_event: string, fn: () => void) { mocks.click = fn }
    show() { mocks.show() }
  },
}))
import { checkSettled, checkStarted, notifyTask, setTaskSurface } from '../src/main/task-notify.js'

beforeEach(() => {
  mocks.supported = true; mocks.focused = false; mocks.click = undefined; mocks.show.mockClear()
  vi.unstubAllEnvs()
})

it('opens the correct conversation when a background notification is clicked', () => {
  const surface = vi.fn(), broadcast = vi.fn()
  setTaskSurface(surface)
  notifyTask({ state: 'done', goal: 'Prepare the report', botId: 'bot-42' } as DelegatedTask, broadcast)
  expect(mocks.show).toHaveBeenCalledOnce()
  expect(surface).not.toHaveBeenCalled()
  mocks.click!()
  expect(surface).toHaveBeenCalledOnce()
  expect(broadcast).toHaveBeenCalledWith({ type: 'comet:open', botId: 'bot-42' })
})

it.each(['focused', 'hidden', 'unsupported'])('does not interrupt the user for %s runs', condition => {
  if (condition === 'focused') mocks.focused = true
  if (condition === 'hidden') vi.stubEnv('ENGRAM_HIDDEN', '1')
  if (condition === 'unsupported') mocks.supported = false
  notifyTask({ state: 'waiting', goal: 'A task', botId: 'bot-1' } as DelegatedTask, vi.fn())
  expect(mocks.show).not.toHaveBeenCalled()
})

it('uses an in-app notice when Engram is focused without exposing task contents', () => {
  mocks.focused = true
  const broadcast = vi.fn()
  notifyTask({ state: 'done', goal: 'Private report', botId: 'bot-42' } as DelegatedTask, broadcast)
  expect(broadcast).toHaveBeenCalledWith({ type: 'task:notice', message: 'Task done' })
  expect(mocks.show).not.toHaveBeenCalled()
})

it('tells a finished answer only once the after-turn check and its extra pass have settled', () => {
  checkStarted('bot-7')
  notifyTask({ state: 'done', goal: 'A task', botId: 'bot-7' } as DelegatedTask, vi.fn())
  expect(mocks.show).not.toHaveBeenCalled()
  // The extra pass checks its own answer before the first check lets go.
  checkStarted('bot-7')
  checkSettled('bot-7')
  expect(mocks.show).not.toHaveBeenCalled()
  checkSettled('bot-7')
  expect(mocks.show).toHaveBeenCalledOnce()
})

it('holds a done notice while a replay is queued and emits at most once per task', async () => {
  const { taskQueued } = await import('../src/main/task-notify.js')
  const task = { id: 'notice-once', state: 'done', botId: 'notice-bot' } as DelegatedTask
  const broadcast = vi.fn()
  taskQueued(task.botId, true)
  checkStarted(task.botId)
  notifyTask(task, broadcast)
  checkSettled(task.botId)
  expect(mocks.show).not.toHaveBeenCalled()
  taskQueued(task.botId, false)
  expect(mocks.show).toHaveBeenCalledOnce()
  notifyTask(task, broadcast)
  expect(mocks.show).toHaveBeenCalledOnce()
})


it('holds completion while the renderer has queued work even after host pending clears', async () => {
  const { taskQueued, clientTaskQueued, clearClientTaskQueues } = await import('../src/main/task-notify.js')
  clientTaskQueued('client-queue', true, 99)
  notifyTask({ id: 'client-task', botId: 'client-queue', state: 'done' } as DelegatedTask, vi.fn())
  taskQueued('client-queue', false)
  expect(mocks.show).not.toHaveBeenCalled()
  clearClientTaskQueues(99)
  expect(mocks.show).toHaveBeenCalledOnce()
})
