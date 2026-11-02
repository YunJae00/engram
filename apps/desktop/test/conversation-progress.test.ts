import { expect, it } from 'vitest'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'

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
