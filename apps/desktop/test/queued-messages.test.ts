import { expect, it, vi } from 'vitest'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { flushQueuedCometMessages, sendCometMessage } from '../src/renderer/src/lib/attachments.js'
import { persistQueues, readQueued } from '../src/renderer/src/lib/queuedStorage.js'
import type { EngramEvent } from '../src/shared/types.js'

it('queues follow-ups in order, keeps files separate and sends only after the full answer', async () => {
  const store = createCometThreads(); const listeners = new Set<(event: EngramEvent) => void>()
  const api = { onEvent: (listener: (event: EngramEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, chatSend: vi.fn(async () => undefined) }
  await sendCometMessage(api, store, 'one', 'First')
  const file = { id: 'file-one', name: 'notes.txt', size: 5 }
  await sendCometMessage(api, store, 'one', 'Second', [file])
  await sendCometMessage(api, store, 'one', 'Third')
  expect(api.chatSend).toHaveBeenCalledOnce()
  expect(store.thread('one').queued.map(message => message.draft)).toEqual(['Second', 'Third'])
  expect(store.thread('one').messages).toHaveLength(2)
  store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'First answer' })
  store.setDraft('one', 'Still typing')
  await flushQueuedCometMessages(api, store, 'one')
  expect(api.chatSend.mock.calls[1]?.[0]).toMatchObject({ message: 'Second\n\nAttached: notes.txt', attachments: ['file-one'], history: [{ role: 'user', text: 'First' }, { role: 'assistant', text: 'First answer' }] })
  expect(store.thread('one').draft).toBe('Still typing')
  store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'Second answer' })
  await flushQueuedCometMessages(api, store, 'one')
  expect(api.chatSend).toHaveBeenCalledTimes(3)
  expect(store.thread('one').queued).toEqual([])
})
it('holds pending messages after Stop or error and allows removal, explicit resume and independent chats', async () => {
  const store = createCometThreads()
  const api = { chatSend: vi.fn(async () => undefined), onEvent: () => () => undefined }
  await sendCometMessage(api, store, 'one', 'First')
  await sendCometMessage(api, store, 'one', 'Second')
  store.stop('one', 'Stopped')
  await flushQueuedCometMessages(api, store, 'one')
  expect(api.chatSend).toHaveBeenCalledOnce()
  await sendCometMessage(api, store, 'other', 'Separate')
  expect(api.chatSend).toHaveBeenCalledTimes(2)
  store.resumeQueue('one'); await flushQueuedCometMessages(api, store, 'one')
  expect(api.chatSend).toHaveBeenCalledTimes(3)
  store.enqueue('one', 'Remove me'); store.enqueue('one', 'Keep me')
  store.removeQueued('one', store.thread('one').queued[0]!.id)
  store.fail('one', 'Connection failed')
  expect(store.thread('one').queueHeld).toBe(true)
  expect(store.thread('one').queued.map(message => message.draft)).toEqual(['Keep me'])
})
it('caps the queue without discarding a draft and clears it on a fresh conversation', () => {
  const store = createCometThreads()
  for (let i = 0; i < 10; i++) expect(store.enqueue('one', `Next ${i}`)).toBe(true)
  store.setDraft('one', 'Keep this draft')
  expect(store.enqueue('one', 'Eleventh')).toBe(false)
  expect(store.thread('one').draft).toBe('Keep this draft')
  store.fresh('one'); expect(store.thread('one').queued).toEqual([])
})
it('persists only queue changes and restores without silently running messages after reload', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: (key: string) => { values.delete(key) } }
  const store = createCometThreads(); const dispose = persistQueues(store, storage)
  store.enqueue('one', 'Remember next')
  store.begin('one', 'First'); store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'Streaming' })
  expect(storage.setItem).toHaveBeenCalledOnce()
  const restored = createCometThreads(); restored.restoreQueue('one', readQueued(storage, 'one'))
  expect(restored.thread('one').queueHeld).toBe(true)
  expect(restored.thread('one').queued[0]?.draft).toBe('Remember next')
  store.forget('one'); expect(readQueued(storage, 'one')).toEqual([])
  expect(readQueued({ getItem: () => '{broken' }, 'one')).toEqual([])
  dispose()
})
