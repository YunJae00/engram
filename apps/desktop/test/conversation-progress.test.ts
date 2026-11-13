import { expect, it, vi } from 'vitest'
import { appendBotTurn, readBotTranscript } from 'core'
vi.mock('../src/main/engine-health.js', () => ({ broadcast: () => {} }))
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { conversationProgress } from '../src/main/conversation-progress.js'
import { setup } from './task-runner-fixture.js'

it('keeps progress and steering in chronological order through completion, reload, and the next question', () => {
  const store = createCometThreads()
  store.begin('one', 'Read all four items')
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'Two items are confirmed; checking the remaining two.' })
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: '', reset: true })
  store.noteUser('one', 'Include the dates')
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'All four items and their dates are confirmed.' })
  store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'All four items and their dates are confirmed.' })
  const expected = ['Read all four items', 'Two items are confirmed; checking the remaining two.', 'Include the dates', 'All four items and their dates are confirmed.']
  expect(store.thread('one').messages.map(m => m.text)).toEqual(expected)
  const disk = store.thread('one').messages
  store.load('one', disk)
  expect(store.thread('one').messages[1]?.progress).toBe(true)
  const history = store.begin('one', 'Which is newest?')
  expect(history.map(message => message.text)).not.toContain(expected[1])
  expect(store.thread('one').messages.slice(0, 4).map(m => m.text)).toEqual(expected)
})

it('does not repeat a partial streamed answer when steering arrives before its final event', () => {
  const store = createCometThreads()
  store.begin('one', 'Read the items')
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'Checked two. ' })
  store.noteUser('one', 'Only show titles')
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'The titles are A and B.' })
  store.handleEvent({ type: 'chat:done', channel: 'bot-one', text: 'Checked two. The titles are A and B.' })
  expect(store.thread('one').messages.map(m => m.text)).toEqual(['Read the items', 'Checked two. ', 'Only show titles', 'The titles are A and B.'])
})

it('shows a progress turn followed directly by its full answer as one bubble after reload', () => {
  const store = createCometThreads()
  store.load('one', [{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'A ', progress: true }, { role: 'assistant', text: 'A B' }])
  expect(store.thread('one').messages.map(m => m.text)).toEqual(['Q', 'A B'])
})

it('keeps a mid-stream message below the answer it interrupted after reload', () => {
  const store = createCometThreads()
  const partial = 'Counted to thirty.\n\n```replies\nMore up to 50'
  store.load('one', [
    { role: 'user', text: 'Count to thirty' }, { role: 'assistant', text: partial, progress: true },
    { role: 'user', text: 'Then only the even ones' }, { role: 'assistant', text: 'Counted to thirty.\n\n```replies\nMore up to 50\nThanks\n```' },
    { role: 'user', text: 'Kings please' }, { role: 'assistant', text: 'Here are the kings.' },
  ])
  expect(store.thread('one').messages.map(m => m.text)).toEqual(['Count to thirty', partial, 'Then only the even ones', 'Kings please', 'Here are the kings.'])
})

it('keeps the stopped reply when nothing streamed, once, and not when a partial is pending', async () => {
  const { paths } = await setup(async () => undefined)
  const progress = conversationProgress(paths)
  await appendBotTurn(paths, 'x', { role: 'user', text: 'Count slowly', at: 'a' })
  await progress.stop('bot-x', 'Stopped.')
  await progress.stop('bot-x', 'Stopped.')
  expect((await readBotTranscript(paths, 'x')).map(t => [t.role, t.text, !!t.progress])).toEqual([['user', 'Count slowly', false], ['assistant', 'Stopped.', false]])
  await appendBotTurn(paths, 'y', { role: 'user', text: 'Count slowly', at: 'a' })
  progress.observe({ type: 'chat:token', channel: 'bot-y', text: 'Half' })
  await progress.stop('bot-y', 'Stopped.')
  progress.observe({ type: 'chat:done', channel: 'bot-y', text: '' })
  await vi.waitFor(async () => expect((await readBotTranscript(paths, 'y')).map(t => [t.text, !!t.progress])).toEqual([['Count slowly', false], ['Half', true]]))
})

it.each([['Tell me more', 'The turn ended without an answer.'], ['더 알려줘', '답을 마치지 못하고 끝났어요.']])('writes an interrupted turn outcome into the thread for %s', async (asked, said) => {
  const t = await setup(async () => undefined)
  await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: asked, at: 'a' })
  await t.chat(asked)
  await t.settle('failed')
  await vi.waitFor(async () => expect((await readBotTranscript(t.paths, 'bot-1')).at(-1)).toMatchObject({ role: 'assistant', text: said }))
  expect(t.events).toContainEqual({ type: 'chat:done', channel: 'bot-bot-1', text: said })
})

it('writes no outcome for a turn the person stopped', async () => {
  const t = await setup(async (_request, _turn, _extra, runner) => { await runner.stopChannel('bot-bot-1'); return undefined })
  await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: 'Tell me more', at: 'a' })
  await t.chat('Tell me more')
  await t.settle('stopped')
  expect((await readBotTranscript(t.paths, 'bot-1')).map(turn => turn.role)).toEqual(['user'])
})
