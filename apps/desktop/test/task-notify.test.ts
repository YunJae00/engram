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
import { notifyTask, setTaskSurface } from '../src/main/task-notify.js'

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
