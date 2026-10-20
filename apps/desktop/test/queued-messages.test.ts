import { expect, it, vi } from 'vitest'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { flushQueuedCometMessages, sendCometMessage, sendQueuedNow } from '../src/renderer/src/lib/attachments.js'
import { threadLang, threadT } from '../src/renderer/src/lib/threadLang.js'
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
it('sends a chosen waiting message now: the reply in progress stops where it is and that message goes first', async () => {
  const store = createCometThreads()
  const api = { chatSend: vi.fn(async () => undefined), onEvent: () => () => undefined, chatAbort: vi.fn(async () => undefined) }
  await sendCometMessage(api, store, 'one', 'First')
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'Half an answer' })
  await sendCometMessage(api, store, 'one', 'Later')
  await sendCometMessage(api, store, 'one', 'Urgent')
  await sendQueuedNow(api, store, 'one', store.thread('one').queued[1]!.id, 'Stopped.')
  expect(api.chatAbort).toHaveBeenCalledWith('bot-one')
  expect(api.chatSend).toHaveBeenCalledTimes(2)
  expect(api.chatSend.mock.calls[1]?.[0]).toMatchObject({ message: 'Urgent', history: [{ role: 'user', text: 'First' }, { role: 'assistant', text: 'Half an answer' }] })
  expect(store.thread('one').queued.map(message => message.draft)).toEqual(['Later'])
  expect(store.thread('one').queueHeld).toBe(false)
})
it('reads the words around a conversation in the language the person writes in', () => {
  expect(threadLang([{ role: 'user', text: 'Find my mail' }, { role: 'user', text: '메일 찾아줘' }])).toBe('ko')
  expect(threadLang([{ role: 'user', text: '메일 찾아줘' }, { role: 'user', text: 'Now in English' }])).toBe('en')
  expect(threadT('ko')('bots.stepSearchWeb', { arg: '공가' })).toBe('“공가” 검색하는 중')
  expect(threadT('en')('bots.thinking')).toBe('Thinking')
  expect(threadT('ko')('mission.title')).toBe('Orbit')
})
it('answers words sent mid-reply at once, above the running work, and queues them only when nothing can take them', async () => {
  const store = createCometThreads()
  const chatSay = vi.fn(async (_channel: string, text: string) => text.startsWith('Stop')
    ? { ok: true, reply: 'Stopping.', action: 'stop' as const }
    : text.startsWith('Then') ? { ok: true, reply: 'That comes next.', action: 'later' as const, instruction: 'Summarize the mail' }
    : { ok: true, reply: 'I will look at Seoul only.', action: 'relay' as const, instruction: 'Only Seoul' })
  const chatAbort = vi.fn(async () => undefined)
  const api = { chatSend: vi.fn(async () => undefined), onEvent: () => () => undefined, chatSay, chatAbort }
  await sendCometMessage(api, store, 'one', 'Find the postings')
  store.setDraft('one', 'Only Seoul please')
  await sendCometMessage(api, store, 'one', 'Only Seoul please')
  expect(store.thread('one').draft).toBe('')
  expect(chatSay).toHaveBeenCalledWith('bot-one', 'Only Seoul please')
  // Said and answered above the work still running, nothing queued.
  expect(store.thread('one').messages.map(m => [m.role, m.text, !!m.aside, !!m.streaming])).toEqual([
    ['user', 'Find the postings', false, false], ['user', 'Only Seoul please', true, false], ['assistant', 'I will look at Seoul only.', true, false], ['assistant', '', false, true]])
  expect(store.thread('one').queued).toEqual([])
  await sendCometMessage(api, store, 'one', 'Then sum up my mail')
  expect(store.thread('one').queued.map(message => message.draft)).toEqual(['Summarize the mail'])
  await sendCometMessage(api, store, 'one', 'Stop that')
  expect(chatAbort).toHaveBeenCalledWith('bot-one')
  expect(store.thread('one').busy).toBe(false)
  expect(store.thread('one').messages.at(-1)?.text).toBe('Stopping.')
  // With no voice to take it, the words wait their turn.
  const quiet = createCometThreads()
  const offline = { chatSend: vi.fn(async () => undefined), onEvent: () => () => undefined, chatSay: vi.fn(async () => ({ ok: false })) }
  await sendCometMessage(offline, quiet, 'two', 'Find the postings')
  await sendCometMessage(offline, quiet, 'two', 'Nothing running to take this')
  expect(quiet.thread('two').queued.map(message => message.draft)).toEqual(['Nothing running to take this'])
  quiet.setDraft('two', 'still typing')
  quiet.handleEvent({ type: 'chat:steer-returned', channel: 'bot-two', texts: ['Too late for that turn'] })
  expect(quiet.thread('two').queued.map(message => message.draft)).toEqual(['Nothing running to take this', 'Too late for that turn'])
  expect(quiet.thread('two').draft).toBe('still typing')
})
