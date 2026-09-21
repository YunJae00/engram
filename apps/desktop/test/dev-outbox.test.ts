import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DevOutbox, pauseOutbox } from '../src/main/dev-outbox.js'
import { DevStore } from '../src/main/dev-store.js'
import type { DevSession } from '../src/shared/developers.js'

async function fixture() {
  await mkdir(resolve('tmp'), { recursive: true })
  const store = new DevStore(join(await mkdtemp(resolve('tmp/dev-outbox-')), 'state.json'))
  store.data.preferences.enabled = true
  const session = { id: 'task', cwd: '.', state: 'running', items: [], pending: [], usage: {} } as unknown as DevSession
  store.data.sessions.push(session)
  const send = vi.fn(async () => { session.state = 'running' })
  const queue = new DevOutbox(store, vi.fn(), send)
  return { store, session, send, queue }
}

it('saves and edits queued messages, dispatches once in order and pauses on restart', async () => {
  const { store, session, send, queue } = await fixture()
  await queue.add(session, 'First'); await queue.add(session, 'Second')
  expect(send).not.toHaveBeenCalled()
  await queue.update(session, session.outbox![1]!.id, 'edit', 'Changed second')
  session.state = 'idle'; queue.schedule(session); queue.schedule(session)
  await vi.waitFor(() => expect(session.outbox).toHaveLength(1))
  expect(send.mock.calls).toEqual([['task', 'First']])
  session.state = 'idle'; queue.schedule(session)
  await vi.waitFor(() => expect(session.outbox).toHaveLength(0))
  expect(send.mock.calls).toEqual([['task', 'First'], ['task', 'Changed second']])
  await queue.add(session, 'After restart')
  const restored = new DevStore(store.file); await restored.load()
  expect(restored.session('task').outbox![0]!.state).toBe('paused')
  const afterRestart = new DevOutbox(restored, vi.fn(), send)
  afterRestart.schedule(restored.session('task'))
  expect(send).toHaveBeenCalledTimes(2)
})

it('never replays an uncertain delivery and pauses remaining messages', async () => {
  const { store, session, send, queue } = await fixture()
  await queue.add(session, 'Possibly executed'); await queue.add(session, 'Do not continue')
  send.mockRejectedValueOnce(new Error('Connection dropped after dispatch'))
  session.state = 'idle'; queue.schedule(session)
  await vi.waitFor(() => expect(session.outbox?.map(value => value.state)).toEqual(['uncertain', 'paused']))
  await expect(queue.update(session, session.outbox![0]!.id, 'resume')).rejects.toThrow('Delivery was not confirmed')
  queue.schedule(session)
  expect(send).toHaveBeenCalledTimes(1)
  await store.save()
  const restored = new DevStore(store.file); await restored.load()
  expect(restored.session('task').outbox?.map(value => value.state)).toEqual(['uncertain', 'paused'])
})

it('does not dispatch when disabled while saving the dispatch marker', async () => {
  const { store, session, send, queue } = await fixture()
  await queue.add(session, 'Cancelled before dispatch')
  let release!: () => void
  const save = vi.spyOn(store, 'save').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  session.state = 'idle'; queue.schedule(session)
  await vi.waitFor(() => expect(save).toHaveBeenCalled())
  store.data.preferences.enabled = false; pauseOutbox(session); release()
  await vi.waitFor(() => expect(session.outbox![0]!.state).toBe('paused'))
  expect(send).not.toHaveBeenCalled()
})

it('validates text, queue size and actions without sending invalid requests', async () => {
  const { session, send, queue } = await fixture()
  await expect(queue.add(session, '')).rejects.toThrow('Enter a message')
  await expect(queue.add(session, 'x'.repeat(100001))).rejects.toThrow('100,000')
  for (let index = 0; index < 10; index++) await queue.add(session, String(index))
  await expect(queue.add(session, 'overflow')).rejects.toThrow('10 messages')
  await expect(queue.update(session, session.outbox![0]!.id, 'edit', '')).rejects.toThrow('Enter a message')
  await queue.update(session, session.outbox![0]!.id, 'remove')
  expect(session.outbox).toHaveLength(9); expect(send).not.toHaveBeenCalled()
})
