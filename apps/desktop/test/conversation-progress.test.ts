import { expect, it, vi } from 'vitest'
import { appendBotTurn, readBotTranscript } from 'core'
import type { EngramEvent } from '../src/shared/types.js'
const heard = vi.hoisted(() => ({ events: [] as unknown[], tap: undefined as undefined | ((event: never) => void) }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: (event: never) => { heard.events.push(event); heard.tap?.(event) } }))
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import { conversationProgress, stopTurn } from '../src/main/conversation-progress.js'
import { setup } from './task-runner-fixture.js'

it('keeps progress and steering in chronological order through completion, reload, and the next question', () => {
  const store = createCometThreads()
  store.begin('one', 'Read all four items')
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'Two items are confirmed; checking the remaining two.' })
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: '', reset: true })
  store.noteUser('one', 'Include the dates', [], true)
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
  expect(store.thread('one').messages.map(m => m.text)).toEqual(['Read the items', 'Checked two. The titles are A and B.', 'Only show titles'])
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

it('a stop after the first text keeps the streamed words as their own turn and ends with the stop line', async () => {
  const { paths } = await setup(async () => undefined)
  const progress = conversationProgress(paths)
  heard.tap = event => progress.observe(event as EngramEvent)
  heard.events.length = 0
  await appendBotTurn(paths, 'x', { role: 'user', text: '지난달 택배비 영수증 다 더해줘', at: 'a' })
  progress.observe({ type: 'chat:token', channel: 'bot-x', text: '영수증 열두 장 중 일곱 장까지 더했어요' })
  await stopTurn(paths, 'bot-x', '멈췄어요.')
  expect((await readBotTranscript(paths, 'x')).map(t => [t.role, t.text, !!t.progress])).toEqual([
    ['user', '지난달 택배비 영수증 다 더해줘', false], ['assistant', '영수증 열두 장 중 일곱 장까지 더했어요', true], ['assistant', '멈췄어요.', false],
  ])
  expect(heard.events.at(-1)).toEqual({ type: 'chat:done', channel: 'bot-x', text: '멈췄어요.' })
  heard.tap = undefined
})

it('a stop before any text stores only the stop line, once', async () => {
  const { paths } = await setup(async () => undefined)
  const progress = conversationProgress(paths)
  heard.tap = event => progress.observe(event as EngramEvent)
  await appendBotTurn(paths, 'y', { role: 'user', text: '다음 분기 출장 일정 짜줘', at: 'a' })
  await stopTurn(paths, 'bot-y', '멈췄어요.')
  expect((await readBotTranscript(paths, 'y')).map(t => [t.role, t.text])).toEqual([['user', '다음 분기 출장 일정 짜줘'], ['assistant', '멈췄어요.']])
  heard.tap = undefined
})

it('keeps interim words in a Korean thread whatever language they are in', async () => {
  const { paths } = await setup(async () => undefined)
  const progress = conversationProgress(paths)
  progress.observe({ type: 'chat:token', channel: 'bot-z', text: 'Q3 shipping totals: 4 of 9 sheets read' })
  await progress.flush('bot-z')
  expect((await readBotTranscript(paths, 'z')).map(t => [t.text, !!t.progress])).toEqual([['Q3 shipping totals: 4 of 9 sheets read', true]])
})

it('an interrupted turn shows and stores the usage line once, and no other host closing', async () => {
  for (const asked of ['Tell me more', '더 알려줘']) {
    const t = await setup(async () => undefined)
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: asked, at: 'a' })
    await t.chat(asked)
    await t.settle('failed')
    const shown = t.events.flatMap(e => e.type === 'chat:error' ? [e.message] : [])
    expect(shown).toHaveLength(1)
    expect((await readBotTranscript(t.paths, 'bot-1')).map(turn => [turn.role, turn.text])).toEqual([['user', asked], ['assistant', shown[0]]])
    expect(t.events.filter(e => e.type === 'chat:done')).toEqual([])
  }
})

it('writes no outcome for a turn the person stopped', async () => {
  const t = await setup(async (_request, _turn, _extra, runner) => { await runner.stopChannel('bot-bot-1'); return undefined })
  await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: 'Tell me more', at: 'a' })
  await t.chat('Tell me more')
  await t.settle('stopped')
  expect((await readBotTranscript(t.paths, 'bot-1')).map(turn => turn.role)).toEqual(['user'])
})

it('keeps words the running turn absorbed in place after reload, with the host\'s reply under them', () => {
  const store = createCometThreads()
  store.load('one', [
    { role: 'user', text: '봇 3개로 서울 부산 제주 날씨 조사해줘' }, { role: 'assistant', text: '봇들한테 나눠 맡길게요.', progress: true },
    { role: 'user', text: '아 대구도 추가해', aside: true }, { role: 'assistant', text: '대구도 넣을게요.', progress: true, aside: true },
    { role: 'assistant', text: '네 도시 날씨예요.\n\n| 도시 | 날씨 |' },
  ])
  expect(store.thread('one').messages.map(m => m.text)).toEqual(['봇 3개로 서울 부산 제주 날씨 조사해줘', '봇들한테 나눠 맡길게요.', '아 대구도 추가해', '대구도 넣을게요.', '네 도시 날씨예요.\n\n| 도시 | 날씨 |'])
})

it('keeps words that are not handed to the running turn below its answer', () => {
  const store = createCometThreads()
  store.begin('one', 'Read the items')
  store.noteUser('one', 'Then look at this file')
  store.handleEvent({ type: 'chat:token', channel: 'bot-one', text: 'The items are A and B.' })
  expect(store.thread('one').messages.map(m => m.text)).toEqual(['Read the items', 'The items are A and B.', 'Then look at this file'])
  const other = createCometThreads()
  other.begin('one', 'Read the items')
  other.noteUser('one', 'Only titles', [], true)
  expect(other.thread('one').messages.map(m => m.text)).toEqual(['Read the items', 'Only titles', ''])
  other.sinkUser('one', 'Only titles')
  expect(other.thread('one').messages.map(m => m.text)).toEqual(['Read the items', '', 'Only titles'])
})
