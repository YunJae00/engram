import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DelegatedTask } from 'core'

const mocks = vi.hoisted(() => ({ supported: true, focused: false, show: vi.fn(), click: undefined as (() => void) | undefined, last: { title: '', body: '' } }))
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => mocks.focused ? {} : null },
  Notification: class {
    constructor(options: { title: string; body: string }) { mocks.last = options }
    static isSupported() { return mocks.supported }
    on(_event: string, fn: () => void) { mocks.click = fn }
    show() { mocks.show() }
  },
}))
import { notifyTask, setTaskSurface } from '../src/main/task-notify.js'

beforeEach(() => {
  mocks.supported = true; mocks.focused = false; mocks.click = undefined; mocks.show.mockClear()
  vi.unstubAllEnvs()
  // The orchestrator or a hidden app run may export ENGRAM_HIDDEN=1; these tests choose it themselves.
  vi.stubEnv('ENGRAM_HIDDEN', undefined)
})

afterEach(() => vi.unstubAllEnvs())

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
  notifyTask({ state: 'waiting', approvals: [], goal: 'A task', botId: 'bot-1' } as DelegatedTask, vi.fn())
  expect(mocks.show).not.toHaveBeenCalled()
})


it('holds a done notice while a replay is queued and emits at most once per task', async () => {
  const { taskQueued } = await import('../src/main/task-notify.js')
  const task = { id: 'notice-once', state: 'done', botId: 'notice-bot' } as DelegatedTask
  const broadcast = vi.fn()
  taskQueued(task.botId, true)
  notifyTask(task, broadcast)
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

const at = (id: string, state: string, extra: object = {}) => ({ id, botId: `bot-${id}`, state, approvals: [], ...extra }) as unknown as DelegatedTask
const open = { approvals: [{ answer: undefined }] }

it('shows no in-app notice for a done task while Engram is focused', () => {
  mocks.focused = true
  const broadcast = vi.fn()
  for (const task of [at('f-done', 'done'), at('f-paused', 'waiting'), at('f-q', 'waiting', { question: 'Which?' }), at('f-ap', 'waiting', open)]) notifyTask(task, broadcast)
  expect(broadcast).not.toHaveBeenCalled()
  expect(mocks.show).not.toHaveBeenCalled()
})

it('notify off suppresses OS notification', () => {
  for (const task of [at('off-done', 'done'), at('off-failed', 'failed'), at('off-q', 'waiting', { question: 'Which?' }), at('off-ap', 'waiting', open)]) notifyTask(task, vi.fn(), 'off')
  expect(mocks.show).not.toHaveBeenCalled()
  mocks.focused = true
  const broadcast = vi.fn()
  notifyTask(at('off-focused', 'failed'), broadcast, 'off')
  expect(broadcast).not.toHaveBeenCalled()
})

it('attention level shows only questions, approvals and failures', () => {
  for (const task of [at('att-done', 'done'), at('att-paused', 'waiting')]) notifyTask(task, vi.fn(), 'attention')
  expect(mocks.show).not.toHaveBeenCalled()
  for (const [n, task] of [at('att-failed', 'failed'), at('att-q', 'waiting', { question: 'Which?' }), at('att-ap', 'waiting', open)].entries()) {
    notifyTask(task, vi.fn(), 'attention')
    expect(mocks.show).toHaveBeenCalledTimes(n + 1)
  }
})

it('unknown or missing level behaves as all', () => {
  for (const [n, level] of [undefined, 'all', 'bogus'].entries()) {
    notifyTask(at(`lvl-${n}`, 'done'), vi.fn(), level)
    expect(mocks.show).toHaveBeenCalledTimes(n + 1)
  }
})

const kinds = [['done', {}], ['failed', {}], ['waiting', { question: 'Which?' }], ['waiting', open], ['waiting', {}]] as const
it.each(kinds.map(([state, extra], n) => [n, state, extra] as const))('speaks the goal language in notification %i (%s)', (n, state, extra) => {
  notifyTask(at(`ko-${n}`, state, { ...extra, goal: '보고서 정리' }), vi.fn())
  expect(mocks.last.title).toMatch(/[가-힣]/)
  expect(mocks.last.body).toMatch(/[가-힣]/)
  notifyTask(at(`en-${n}`, state, { ...extra, goal: 'Tidy the report' }), vi.fn())
  expect(`${mocks.last.title} ${mocks.last.body}`).not.toMatch(/[가-힣]/)
  if (state === 'failed') expect(mocks.last.title).toBe('Task stopped')
})
