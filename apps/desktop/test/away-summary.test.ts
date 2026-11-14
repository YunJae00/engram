import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { readNotices, type DelegatedTask, type NoticeItem, type VaultPaths } from 'core'
import { AWAY_MS, awayChanges, awayReady, awayText, mainFocus, vaultIo, type AwayIo } from '../src/main/away-summary.js'

const T0 = Date.parse('2026-11-01T09:00:00Z'), MIN = 60_000
const iso = (min: number) => new Date(T0 + min * MIN).toISOString()
let n = 0
const task = (botId: string, state: string, min: number, extra: object = {}) => ({
  id: `t${n++}`, botId, state, goal: 'SECRET-GOAL 정리', result: 'SECRET-RESULT', approvals: [], log: [],
  createdAt: iso(min - 1), updatedAt: iso(min), ...(['done', 'failed'].includes(state) ? { finishedAt: iso(min) } : {}), ...extra,
}) as unknown as DelegatedTask
const bots = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]

function setup(tasks: DelegatedTask[], notices: Partial<NoticeItem>[] = [], said: { role: string; text: string }[] = []) {
  const post = vi.fn<(item: NoticeItem) => Promise<undefined>>(async () => undefined), changed = vi.fn()
  const io: AwayIo = { tasks: async () => tasks, bots: async () => bots, notices: async () => notices as NoticeItem[], said: async () => said, post }
  awayReady(io, changed)
  return { post, changed, io }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const away = async (from = T0, to = T0 + AWAY_MS) => { mainFocus(false, from); mainFocus(true, to); await settle() }

beforeEach(() => mainFocus(true, 0))

it('posts one summary after ten minutes away when a task finished meanwhile', async () => {
  const { post, changed } = setup([task('a', 'done', 5)])
  await away()
  expect(post).toHaveBeenCalledOnce()
  expect(post.mock.calls[0]![0]).toMatchObject({ kind: 'system', key: 'away', read: false, botId: 'a', title: '자리를 비운 동안', text: 'A: 끝남 1' })
  expect(changed).toHaveBeenCalledOnce()
  mainFocus(true, T0 + AWAY_MS + 1)
  await away(T0 + 20 * MIN, T0 + 30 * MIN - 1000)
  expect(post).toHaveBeenCalledOnce()
})

it('keeps the first unfocused time when it is reported again', async () => {
  const { post } = setup([task('a', 'done', 5)])
  mainFocus(false, T0); mainFocus(false, T0 + 9 * MIN); mainFocus(true, T0 + 10 * MIN)
  await settle()
  expect(post).toHaveBeenCalledOnce()
})

it('posts nothing when no task changed during the absence', async () => {
  const { post, changed } = setup([task('a', 'running', -5), task('a', 'done', -1), task('b', 'waiting', -3, { question: 'Which?' }), task('b', 'stopped', -2), task('gone', 'done', 5)])
  await away()
  expect(post).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
})

it('posts a summary for work that moved on during the absence and is still running', async () => {
  const { post } = setup([task('a', 'running', 5), task('b', 'queued', -5)])
  await away()
  expect(post).toHaveBeenCalledOnce()
  expect(post.mock.calls[0]![0]).toMatchObject({ botId: 'a', text: 'A: 진행 중 1 · B: 진행 중 1' })
})

it('counts finished, waiting and running per bot and opens the bot that waits', async () => {
  const tasks = [task('a', 'done', 2), task('a', 'done', 3), task('a', 'running', -5), task('b', 'waiting', 4, { question: 'Which?' }), task('b', 'failed', 6)]
  const { post } = setup(tasks)
  await away()
  const item = post.mock.calls[0]![0]
  expect(item.text).toBe('A: 끝남 2, 진행 중 1 · B: 답 기다림 2')
  expect(item.botId).toBe('b')
  expect(`${item.title} ${item.text}`).not.toContain('SECRET')
})

it('speaks English when the latest person message is English', async () => {
  const { post } = setup([task('a', 'done', 2), task('a', 'done', 3), task('a', 'running', -5)], [], [{ role: 'user', text: '정리해줘' }, { role: 'user', text: 'Now in English' }])
  await away()
  expect(post.mock.calls[0]![0]).toMatchObject({ title: 'While you were away', text: 'A: 2 finished, 1 still running' })
})

it('leaves out only the scheduled run that already has its own notice', async () => {
  const ended = { kind: 'scheduled', botId: 'a', began: iso(2), at: iso(4) } as const
  const only = setup([task('a', 'done', 4, { createdAt: iso(2) })], [ended])
  await away()
  expect(only.post).not.toHaveBeenCalled()
  const running = setup([task('b', 'running', 6)], [{ kind: 'scheduled', botId: 'b', at: iso(5), running: true }])
  await away()
  expect(running.post).not.toHaveBeenCalled()
  const mixed = setup([task('a', 'done', 4, { createdAt: iso(2) }), task('a', 'done', 8), task('a', 'waiting', 1, { question: 'Which?' })], [ended])
  await away()
  expect(mixed.post.mock.calls[0]![0]).toMatchObject({ botId: 'a', text: 'A: 끝남 1, 답 기다림 1' })
})

it('summarizes a task that stopped during the absence', async () => {
  const { post } = setup([task('b', 'stopped', 5), task('a', 'done', -3)])
  await away()
  expect(post).toHaveBeenCalledOnce()
  expect(post.mock.calls[0]![0]).toMatchObject({ botId: 'b', text: 'B: 멈춤 1' })
  expect(awayText([{ botId: 'b', name: 'B', finished: 0, waiting: 0, running: 0, stopped: 2 }], 'en').text).toBe('B: 2 stopped')
})

it('does not count a change that happened after the person came back', async () => {
  const { post } = setup([task('a', 'done', 10.5), task('b', 'waiting', 11, { question: 'Which?' })])
  await away()
  expect(post).not.toHaveBeenCalled()
  const later = setup([task('a', 'done', 5), task('b', 'waiting', 11, { question: 'Which?' }), task('b', 'running', 11, { createdAt: iso(10.5) })])
  await away()
  expect(later.post.mock.calls[0]![0]).toMatchObject({ botId: 'a', text: 'A: 끝남 1' })
})

it('keeps a manual task on the same bot that changed during a scheduled run', async () => {
  const ended = { kind: 'scheduled', botId: 'a', began: iso(2), at: iso(6) } as const
  const sched = task('a', 'done', 6, { createdAt: iso(2) })
  const manual = task('a', 'done', 4, { createdAt: iso(-30) })
  const { post } = setup([sched, manual], [ended])
  await away()
  expect(post.mock.calls[0]![0]).toMatchObject({ botId: 'a', text: 'A: 끝남 1' })
  const beside = task('a', 'waiting', 5, { createdAt: iso(3), question: 'Which?' })
  const both = setup([sched, beside], [ended])
  await away()
  expect(both.post.mock.calls[0]![0]).toMatchObject({ botId: 'a', text: 'A: 답 기다림 1' })
})

it('leaves out a waiting task that a scheduled run picked up, but not the one it replaced', async () => {
  const ended = { kind: 'scheduled', botId: 'a', began: iso(2), at: iso(6) } as const
  const resumed = task('a', 'done', 6, { createdAt: iso(-60) })
  const only = setup([resumed], [ended])
  await away()
  expect(only.post).not.toHaveBeenCalled()
  const replaced = setup([resumed, task('a', 'stopped', 2, { createdAt: iso(-90) })], [ended])
  await away()
  expect(replaced.post.mock.calls[0]![0]).toMatchObject({ botId: 'a', text: 'A: 멈춤 1' })
})

it('keeps the work of a busy conversation that turned a scheduled run away', async () => {
  const turnedAway = { kind: 'scheduled', botId: 'a', at: iso(6) } as const
  const { post } = setup([task('a', 'done', 6, { createdAt: iso(-60) })], [turnedAway])
  await away()
  expect(post.mock.calls[0]![0]).toMatchObject({ botId: 'a', text: 'A: 끝남 1' })
})

it('posts nothing and does not throw when the tasks cannot be read', async () => {
  const { post, io } = setup([])
  io.tasks = async () => { throw new Error('unreadable') }
  await away()
  expect(post).not.toHaveBeenCalled()
})

it('names at most five bots and says how many more', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ botId: `${i}`, name: `Bot${i}`, finished: 1, waiting: 0, running: 0 }))
  expect(awayText(rows, 'en').text).toBe(`${rows.slice(0, 5).map(row => `${row.name}: 1 finished`).join(' · ')} and 2 more`)
  expect(awayText(rows, 'ko').text).toMatch(/ 외 2개$/)
  expect(awayChanges([], bots, T0)).toBeUndefined()
})

it('replaces an unread summary and keeps a read one', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'away-'))
  try {
    const paths = { cache } as VaultPaths, io = vaultIo(paths)
    const item = (id: string, read: boolean): NoticeItem => ({ id, kind: 'system', key: 'away', title: 't', text: id, at: iso(0), read })
    await io.post(item('read', true)); await io.post(item('old', false)); await io.post(item('new', false))
    expect((await readNotices(paths)).map(one => one.id)).toEqual(['new', 'read'])
  } finally { await rm(cache, { recursive: true, force: true }) }
})
