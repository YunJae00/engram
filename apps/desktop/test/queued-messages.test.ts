import { expect, it, vi } from 'vitest'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { flushQueuedCometMessages, sendCometMessage } from '../src/renderer/src/lib/attachments.js'
import { threadLang, threadT } from '../src/renderer/src/lib/threadLang.js'
import type { EngramEvent } from '../src/shared/types.js'

const api = () => {
  const listeners = new Set<(event: EngramEvent) => void>()
  return { onEvent: (listener: (event: EngramEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, chatSend: vi.fn(async () => undefined) }
}

it('ignores a late voice reply after stop, even after its done echo', async () => {
  const store = createCometThreads()
  let reply!: (answer: { ok: true; action: 'later'; instruction: string }) => void
  const client = { ...api(), chatSay: () => new Promise<{ ok: true; action: 'later'; instruction: string }>(resolve => { reply = resolve }) }
  await sendCometMessage(client, store, 'one', 'First')
  const pending = sendCometMessage(client, store, 'one', 'Then this')
  store.stop('one', 'Stopped')
  store.clearStopped('one')
  reply({ ok: true, action: 'later', instruction: 'Then this' })
  await pending
  expect(store.thread('one').queued).toEqual([])
  expect(client.chatSend).toHaveBeenCalledTimes(1)
})

it('starts a late follow-up after completion and preserves the newer draft', async () => {
  const store = createCometThreads()
  let reply!: (answer: { ok: true; action: 'later'; instruction: string }) => void
  const client = { ...api(), chatSay: () => new Promise<{ ok: true; action: 'later'; instruction: string }>(resolve => { reply = resolve }) }
  await sendCometMessage(client, store, 'one', 'First')
  const pending = sendCometMessage(client, store, 'one', 'Then this')
  store.setDraft('one', 'Still typing')
  store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'Done' })
  reply({ ok: true, action: 'later', instruction: 'Then this' })
  await pending
  expect(client.chatSend).toHaveBeenCalledTimes(2)
  expect(store.thread('one').draft).toBe('Still typing')
})

it('shows words sent mid-reply at once in the running work and answers them there', async () => {
  const store = createCometThreads()
  const chatSay = vi.fn(async () => ({ ok: true, reply: 'I will look at Seoul only.', action: 'relay' as const, instruction: 'Only Seoul' }))
  const client = { ...api(), chatSay }
  await sendCometMessage(client, store, 'one', 'Find the postings')
  store.setDraft('one', 'Only Seoul please')
  await sendCometMessage(client, store, 'one', 'Only Seoul please')
  expect(store.thread('one').draft).toBe('')
  expect(chatSay).toHaveBeenCalledWith('bot-one', 'Only Seoul please')
  expect(store.thread('one').workLines).toEqual(['you: Only Seoul please', 'said: I will look at Seoul only.'])
  expect(store.thread('one').messages.map(m => m.role)).toEqual(['user', 'assistant'])
  expect(store.thread('one').queued).toEqual([])
})

it('keeps what is for after this turn out of sight, and starts it when the turn ends without showing the words twice', async () => {
  const store = createCometThreads()
  const client = { ...api(), chatSay: vi.fn(async () => ({ ok: true, reply: 'That comes next.', action: 'later' as const, instruction: 'Summarize the mail' })) }
  await sendCometMessage(client, store, 'one', 'Find the postings')
  await sendCometMessage(client, store, 'one', 'Then sum up my mail')
  const file = { id: 'file-one', name: 'notes.txt', size: 5 }
  await sendCometMessage(client, store, 'one', 'Look at this too', [file])
  expect(store.thread('one').workLines).toEqual(['you: Then sum up my mail', 'said: That comes next.', 'you: Look at this too\n\nAttached: notes.txt', `said: ${threadT('en')('aside.next')}`])
  expect(store.thread('one').queued.map(one => [one.draft, one.shown])).toEqual([['Summarize the mail', true], ['Look at this too', true]])
  store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'Postings found' })
  await flushQueuedCometMessages(client, store, 'one')
  expect(client.chatSend.mock.calls[1]?.[0]).toMatchObject({ message: 'Summarize the mail' })
  // Already said in the conversation: no second bubble for it.
  expect(store.thread('one').messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['Find the postings'])
  store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'Mail summed up' })
  await flushQueuedCometMessages(client, store, 'one')
  expect(client.chatSend.mock.calls[2]?.[0]).toMatchObject({ message: 'Look at this too\n\nAttached: notes.txt', attachments: ['file-one'] })
})

it('stops where it is when told to, and what was set to follow stops with it', async () => {
  const store = createCometThreads()
  const chatAbort = vi.fn(async () => undefined)
  const client = { ...api(), chatAbort, chatSay: vi.fn(async (_channel: string, text: string) => text.startsWith('Stop') ? { ok: true, reply: 'Stopping.', action: 'stop' as const } : { ok: true, reply: 'Next.', action: 'later' as const, instruction: 'Then this' }) }
  await sendCometMessage(client, store, 'one', 'First')
  await sendCometMessage(client, store, 'one', 'Then this')
  await sendCometMessage(client, store, 'one', 'Stop that')
  expect(chatAbort).toHaveBeenCalledWith('bot-one')
  expect(store.thread('one').busy).toBe(false)
  expect(store.thread('one').messages.at(-1)?.text).toBe('Stopping.')
  expect(store.thread('one').queued).toEqual([])
})

it('acknowledges at once without a voice, and the words go on after this turn', async () => {
  const store = createCometThreads()
  const client = { ...api(), chatSay: vi.fn(async () => ({ ok: false })) }
  await sendCometMessage(client, store, 'two', 'Find the postings')
  await sendCometMessage(client, store, 'two', 'Nothing running to take this')
  expect(store.thread('two').workLines.at(-1)).toBe(`said: ${threadT('en')('aside.next')}`)
  expect(store.thread('two').queued.map(message => message.draft)).toEqual(['Nothing running to take this'])
  store.setDraft('two', 'still typing')
  store.handleEvent({ type: 'chat:steer-returned', channel: 'bot-two', texts: ['Too late for that turn'] })
  expect(store.thread('two').queued.map(message => [message.draft, message.shown])).toEqual([['Nothing running to take this', true], ['Too late for that turn', true]])
  expect(store.thread('two').draft).toBe('still typing')
})

it('sends a second message typed before the first took its seat right after it, shown when it starts', async () => {
  const store = createCometThreads()
  const client = api()
  let release: () => void = () => undefined
  client.chatSend.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined) }))
  const first = sendCometMessage(client, store, 'one', 'First')
  store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'Done' })
  await sendCometMessage(client, store, 'one', 'Second')
  expect(store.thread('one').queued.map(one => [one.draft, !!one.shown])).toEqual([['Second', false]])
  release(); await first
  await flushQueuedCometMessages(client, store, 'one')
  expect(client.chatSend.mock.calls[1]?.[0]).toMatchObject({ message: 'Second' })
  expect(store.thread('one').messages.filter(m => m.role === 'user').map(m => m.text)).toEqual(['First', 'Second'])
})

it('reads the words around a conversation in the language the person writes in', () => {
  expect(threadLang([{ role: 'user', text: 'Find my mail' }, { role: 'user', text: '메일 찾아줘' }])).toBe('ko')
  expect(threadLang([{ role: 'user', text: '메일 찾아줘' }, { role: 'user', text: 'Now in English' }])).toBe('en')
  expect(threadT('ko')('bots.stepSearchWeb', { arg: '공가' })).toBe('“공가” 검색하는 중')
  expect(threadT('en')('bots.thinking')).toBe('Thinking')
  expect(threadT('ko')('aside.next')).toBe('알겠어요. 지금 하던 거 끝나면 바로 할게요.')
})
