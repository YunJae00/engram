import { expect, it } from 'vitest'
import { done, setup } from './task-runner-fixture.js'
import { acknowledgeHanded, changeCheckpoint, readCheckpoint } from '../src/main/comet-checkpoint.js'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'

it('preserves an input arriving after the turn snapshot for the next model call', async () => {
  const t = await setup(async () => done('Done'))
  await changeCheckpoint(t.paths, 'one', state => ({ ...state, pending: ['First instruction'] }))
  const delivered = await readCheckpoint(t.paths, 'one')
  await changeCheckpoint(t.paths, 'one', state => ({ ...state, pending: [...state.pending, 'Late instruction'] }))
  await acknowledgeHanded(t.paths, 'one', delivered.pending, 'First instruction recorded')
  expect((await readCheckpoint(t.paths, 'one')).pending).toEqual(['Late instruction'])
})

it('does not queue or judge instructions from retired resend events', () => {
  const store = createCometThreads('one')
  store.handleEvent({ type: 'chat:steer-returned', channel: 'bot-one', texts: ['Do not submit'] })
  store.handleEvent({ type: 'chat:steer-unapplied', channel: 'bot-one', texts: ['Do not submit'] })
  expect(store.thread('one').queued).toEqual([])
  expect(store.thread('one').unapplied).toEqual([])
})
