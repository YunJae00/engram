import { expect, it } from 'vitest'
import { listTasks } from 'core'
import { done, setup } from './task-runner-fixture.js'
import { changeCheckpoint, readCheckpoint, settleHanded } from '../src/main/comet-checkpoint.js'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'

it('removes left instructions from pending and returns them only once', async () => {
  const t = await setup(async () => done('Done'))
  await changeCheckpoint(t.paths, 'bot-1', state => ({ ...state, pending: ['Do not submit'] }))
  expect(await settleHanded(t.paths, 'bot-1', ['Do not submit'], ['Do not submit'])).toEqual({ queued: ['Do not submit'], unapplied: [] })
  expect((await readCheckpoint(t.paths, 'bot-1')).pending).toEqual([])
  expect(await settleHanded(t.paths, 'bot-1', ['Do not submit'], ['Do not submit'])).toEqual({ queued: [], unapplied: ['Do not submit'] })
})

it('continues the original task once without creating a repeated goal, learning, or notifying', async () => {
  const t = await setup(async () => done('Done'))
  await t.chat('Prepare the draft')
  const original = (await listTasks(t.paths))[0]!
  t.notified.length = 0
  const request = { engineId: '', botId: 'bot-1', channel: 'bot-bot-1', message: 'Do not submit', history: [], previouslySaid: true }
  await t.runner.chat(request)
  await t.runner.chat(request)
  const tasks = await listTasks(t.paths)
  expect(tasks).toHaveLength(1)
  expect(tasks[0]).toMatchObject({ id: original.id, goal: original.goal, turns: 2 })
  expect(t.sent).toHaveLength(2)
  expect(t.learned).toEqual([])
  expect(t.notified).toEqual([])
  expect(t.events).toContainEqual({ type: 'chat:steer-unapplied', channel: request.channel, texts: ['Do not submit'] })
})

it('never consumes an automatic resend as an answer to a pending question', async () => {
  const t = await setup(async () => ({ ...done('Which date?'), asked: true }))
  await t.chat('Prepare a draft')
  await t.runner.chat({ engineId: '', botId: 'bot-1', message: 'Do not submit', history: [], previouslySaid: true })
  expect(t.sent).toHaveLength(1)
  expect(t.learned).toEqual([])
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', question: 'Which date?', turns: 1 })
})

it('shows unapplied instructions without automatically queueing them or replacing question choices', () => {
  const store = createCometThreads('one')
  store.handleEvent({ type: 'chat:steer-unapplied', channel: 'bot-one', texts: ['Do not submit'] })
  expect(store.thread('one').unapplied).toEqual(['Do not submit'])
  expect(store.thread('one').queued).toEqual([])
  store.clearUnapplied('one', 'Do not submit')
  expect(store.thread('one').unapplied).toEqual([])
})
