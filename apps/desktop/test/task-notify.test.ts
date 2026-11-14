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
  if (state === 'failed') expect(mocks.last.title).toBe('Engram: Stopped')
})

const ko = [{ role: 'user', text: '보고서 정리해줘' }]
it('puts the bot name in a title that follows the conversation language', () => {
  const titles = [['done', {}, '리서치봇: 다 했어요'], ['waiting', { question: 'Which?' }, '리서치봇: 답이 필요해요'], ['waiting', open, '리서치봇: 확인이 필요해요'], ['waiting', {}, '리서치봇: 여기까지 했어요']] as const
  for (const [n, [state, extra, title]] of titles.entries()) {
    notifyTask(at(`name-ko-${n}`, state, { ...extra, goal: 'Prepare the report' }), vi.fn(), 'all', ko, '리서치봇')
    expect(mocks.last.title).toBe(title)
  }
  notifyTask(at('name-en', 'done', { goal: 'Prepare the report' }), vi.fn(), 'all', [], 'Research')
  expect(mocks.last.title).toBe('Research: Done')
  expect(`${mocks.last.title} ${mocks.last.body}`).not.toMatch(/[가-힣]/)
  notifyTask(at('name-latest', 'done', { goal: '보고서 정리' }), vi.fn(), 'all', [...ko, { role: 'user', text: 'Now in English' }], 'Research')
  expect(mocks.last.title).toBe('Research: Done')
  notifyTask(at('name-none', 'done', { goal: '보고서 정리' }), vi.fn())
  expect(mocks.last.title).toBe('Engram: 다 했어요')
})

it('keeps task contents out of the notification', () => {
  for (const [n, [state, extra]] of kinds.entries()) {
    notifyTask(at(`secret-${n}`, state, { ...extra, goal: 'SECRET-GOAL', result: 'SECRET-RESULT', ...('question' in extra ? { question: 'SECRET-Q' } : {}) }), vi.fn(), 'all', [], 'Bot')
    expect(`${mocks.last.title} ${mocks.last.body}`).not.toContain('SECRET')
  }
  expect(mocks.show).toHaveBeenCalledTimes(kinds.length)
})

const MIN = 60_000
const team = (id: string, states: string[], extra: object = {}) => at(id, 'running', {
  goal: '시장 조사', ...extra,
  team: { members: states.map((state, n) => ({ id: `m${n}`, parentId: null, role: n === 0 ? '조사팀' : `팀 ${n}`, state, finishedAt: `2026-01-01T00:0${n}:00Z` })) },
})
const voice = (level?: string, name = '리서치봇') => vi.fn(async () => ({ name, level, transcript: [] }))
const idle = ['working', 'working', 'working', 'working']
const one = ['done', 'working', 'working', 'working']

it('tells a member report as a milestone once per ten minutes per task', async () => {
  const { teamReported } = await import('../src/main/task-notify.js')
  const say = voice(), t0 = 1_000_000
  await teamReported([team('ms-a', idle)], say, vi.fn(), t0)
  expect(mocks.show).not.toHaveBeenCalled()
  await teamReported([team('ms-a', one)], say, vi.fn(), t0)
  expect(mocks.show).toHaveBeenCalledOnce()
  expect(mocks.last).toEqual({ title: '리서치봇: 여기까지 했어요', body: '조사팀 끝 (1/4)' })
  await teamReported([team('ms-a', ['done', 'done', 'working', 'working'])], say, vi.fn(), t0 + 10 * MIN - 1000)
  expect(mocks.show).toHaveBeenCalledOnce()
  await teamReported([team('ms-a', ['done', 'done', 'released', 'working'])], say, vi.fn(), t0 + 10 * MIN)
  expect(mocks.show).toHaveBeenCalledTimes(2)
  expect(mocks.last.body).toBe('팀 2 끝 (3/4)')
  await teamReported([team('ms-a', ['done', 'done', 'released', 'working'])], say, vi.fn(), t0 + 30 * MIN)
  expect(mocks.show).toHaveBeenCalledTimes(2)
})

it('words a milestone in English for an English task and throttles each task on its own', async () => {
  const { teamReported } = await import('../src/main/task-notify.js')
  const en = (id: string, states: string[]) => team(id, states, { goal: 'Market research' })
  const say = voice('all', 'Research')
  await teamReported([en('ms-b', idle), en('ms-c', idle)], say, vi.fn(), 0)
  await teamReported([en('ms-b', one), en('ms-c', one)], say, vi.fn(), 0)
  expect(mocks.show).toHaveBeenCalledTimes(2)
  expect(mocks.last.title).toBe('Research: Progress so far')
  expect(mocks.last.body).toMatch(/ finished \(1\/4\)$/)
  expect(`${mocks.last.title} ${mocks.last.body}`.replace('조사팀', '')).not.toMatch(/[가-힣]/)
})

it('stays quiet about members that had reported before this start, failed, or report to another member', async () => {
  const { teamReported } = await import('../src/main/task-notify.js')
  await teamReported([team('ms-d', one)], voice(), vi.fn(), 0)
  await teamReported([team('ms-d', one)], voice(), vi.fn(), 20 * MIN)
  const sub = team('ms-e', idle), failed = team('ms-e', ['failed', 'released', 'working', 'working'])
  failed.team!.members[1]!.result = 'Failed: no access'
  failed.team!.members[2] = { ...failed.team!.members[2]!, parentId: 'm1', state: 'done' }
  await teamReported([sub], voice(), vi.fn(), 0)
  await teamReported([failed], voice(), vi.fn(), 0)
  expect(mocks.show).not.toHaveBeenCalled()
})

it.each(['focused', 'hidden', 'unsupported', 'attention', 'off', 'waiting'])('shows no milestone when %s', async condition => {
  const { teamReported } = await import('../src/main/task-notify.js')
  const id = `ms-quiet-${condition}`
  await teamReported([team(id, idle)], voice(), vi.fn(), 0)
  if (condition === 'focused') mocks.focused = true
  if (condition === 'hidden') vi.stubEnv('ENGRAM_HIDDEN', '1')
  if (condition === 'unsupported') mocks.supported = false
  const told = team(id, one)
  if (condition === 'waiting') told.state = 'waiting'
  await teamReported([told], voice(['attention', 'off'].includes(condition) ? condition : 'all'), vi.fn(), 0)
  expect(mocks.show).not.toHaveBeenCalled()
  mocks.focused = false
  await teamReported([team(id, one)], voice(), vi.fn(), 20 * MIN)
  expect(mocks.show).not.toHaveBeenCalled()
})

it('shows one milestone for overlapping or out-of-order snapshots and none when the person returns meanwhile', async () => {
  const { teamReported } = await import('../src/main/task-notify.js')
  await teamReported([team('ms-f', idle)], voice(), vi.fn(), 0)
  await Promise.all([teamReported([team('ms-f', one)], voice(), vi.fn(), 0), teamReported([team('ms-f', one)], voice(), vi.fn(), 0)])
  await teamReported([team('ms-f', idle)], voice(), vi.fn(), 20 * MIN)
  await teamReported([team('ms-f', one)], voice(), vi.fn(), 20 * MIN)
  expect(mocks.show).toHaveBeenCalledOnce()
  await teamReported([team('ms-g', idle)], voice(), vi.fn(), 0)
  await teamReported([team('ms-g', one)], vi.fn(async () => { mocks.focused = true; return { name: 'A', level: 'all', transcript: [] } }), vi.fn(), 0)
  expect(mocks.show).toHaveBeenCalledOnce()
})

it('lets the next report through after the bot could not be read, and opens the conversation on click', async () => {
  const { teamReported } = await import('../src/main/task-notify.js')
  const surface = vi.fn(), broadcast = vi.fn()
  setTaskSurface(surface)
  await teamReported([team('ms-h', idle)], voice(), broadcast, 0)
  await expect(teamReported([team('ms-h', one)], vi.fn(async () => { throw new Error('unreadable') }), broadcast, 0)).rejects.toThrow('unreadable')
  await teamReported([team('ms-h', ['done', 'done', 'working', 'working'])], voice(), broadcast, MIN)
  expect(mocks.show).toHaveBeenCalledOnce()
  expect(mocks.last.body).toBe('팀 1 끝 (2/4)')
  mocks.click!()
  expect(surface).toHaveBeenCalledOnce()
  expect(broadcast).toHaveBeenCalledWith({ type: 'comet:open', botId: 'bot-ms-h' })
})

it('forgets a finished task so its id starts quietly again', async () => {
  const { teamReported } = await import('../src/main/task-notify.js')
  await teamReported([team('ms-i', idle)], voice(), vi.fn(), 0)
  await teamReported([{ ...team('ms-i', one), state: 'done' }], voice(), vi.fn(), 0)
  await teamReported([team('ms-i', one)], voice(), vi.fn(), 0)
  expect(mocks.show).not.toHaveBeenCalled()
})
