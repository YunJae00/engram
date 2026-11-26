import { expect, it } from 'vitest'
import { askOrder } from '../src/renderer/src/lib/transcriptOrder.js'
import { cometChannel, createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import type { ChatTurnDto } from '../src/shared/types.js'

const user = (text: string, aside = false): ChatTurnDto => ({ role: 'user', text, ...(aside ? { aside } : {}) })
const answer = (text: string): ChatTurnDto => ({ role: 'assistant', text })
const line = (text: string, aside = false): ChatTurnDto => ({ role: 'assistant', text, progress: true, ...(aside ? { aside } : {}) })
const texts = (list: ChatTurnDto[]): string[] => list.map(turn => turn.text)

it('leaves words the running turn absorbed where they were said, above the one answer that covers them', () => {
  const saved = [user('three cities'), line('splitting it up'), user('add Daegu', true), line('adding Daegu', true), answer('four cities')]
  expect(texts(askOrder(saved))).toEqual(['three cities', 'splitting it up', 'add Daegu', 'adding Daegu', 'four cities'])
  expect(texts(askOrder([user('q'), user('a1', true), user('a2', true), answer('one answer')]))).toEqual(['q', 'a1', 'a2', 'one answer'])
  expect(texts(askOrder([user('q'), line('ack'), user('a1', true)]))).toEqual(['q', 'ack', 'a1'])
  expect(texts(askOrder([user('q'), user('stop', true), answer('stopped')]))).toEqual(['q', 'stop', 'stopped'])
})

it('shows words that got a turn of their own after the running turn\'s answer, their reply line with them', () => {
  expect(texts(askOrder([user('count to thirty'), user('only the even ones', true), answer('1..30'), answer('2, 4, ..')]))).toEqual(['count to thirty', '1..30', 'only the even ones', '2, 4, ..'])
  expect(texts(askOrder([user('q'), user('a1', true), line('on it', true), answer('ans q'), answer('ans a1'), user('next'), answer('ans next')])))
    .toEqual(['q', 'ans q', 'a1', 'on it', 'ans a1', 'next', 'ans next'])
  expect(texts(askOrder([user('q'), user('a1', true), user('a2', true), answer('ans q'), answer('ans a1'), answer('ans a2')]))).toEqual(['q', 'ans q', 'a1', 'ans a1', 'a2', 'ans a2'])
  expect(texts(askOrder([user('q'), user('a1', true), user('a2', true), answer('ans q+a1'), answer('ans a2')]))).toEqual(['q', 'a1', 'ans q+a1', 'a2', 'ans a2'])
})

it('hands words whose answer is on a newer page back to the caller', () => {
  const late: ChatTurnDto[] = []
  expect(texts(askOrder([user('q'), answer('a'), user('q2'), user('edge', true)], late))).toEqual(['q', 'a', 'q2'])
  expect(texts(late)).toEqual(['edge'])
  const none: ChatTurnDto[] = []
  expect(texts(askOrder([user('q'), user('add', true), answer('both'), user('q2'), answer('a2')], none))).toEqual(['q', 'add', 'both', 'q2', 'a2'])
  expect(none).toEqual([])
})

it('keeps a first line where it was shown: ask, first line, the change, the answer', () => {
  const BOT = 'bot-order', channel = cometChannel(BOT)
  const said = (store: ReturnType<typeof createCometThreads>): string[] => store.thread(BOT).messages.map(m => m.text)
  const start = () => { const store = createCometThreads(BOT); store.begin(BOT, '테슬라 오늘 주가 알려줘'); store.handleEvent({ type: 'chat:token', channel, text: '지금 시세 확인할게요.\n\n' }); return store }
  const live = start()
  live.noteUser(BOT, '아 그냥 도요타로 봐 줘', [], true)
  expect(said(live)).toEqual(['테슬라 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '아 그냥 도요타로 봐 줘'])
  live.handleEvent({ type: 'chat:token', channel, text: '', reset: true })
  live.handleEvent({ type: 'chat:done', channel, text: '도요타는 11월 16일 종가 기준 2,950엔이에요.' })
  expect(said(live)).toEqual(['테슬라 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '아 그냥 도요타로 봐 줘', '도요타는 11월 16일 종가 기준 2,950엔이에요.'])
  const replaced = start()
  replaced.noteUser(BOT, '아 그냥 도요타로 봐 줘', [], true)
  replaced.handleEvent({ type: 'chat:token', channel, text: '', reset: true, drop: true })
  replaced.handleEvent({ type: 'chat:done', channel, text: '도요타는 2,950엔이에요.' })
  expect(said(replaced)).toEqual(['테슬라 오늘 주가 알려줘', '아 그냥 도요타로 봐 줘', '도요타는 2,950엔이에요.'])
  const early = createCometThreads(BOT)
  early.begin(BOT, '광주 전주 여수 날씨')
  early.noteUser(BOT, '아 순천도 넣어 줘', [], true)
  expect(said(early)).toEqual(['광주 전주 여수 날씨', '아 순천도 넣어 줘', ''])
})

it('reads a saved first line back above the words said after it was shown, whenever a tool call froze it', () => {
  const at = (turn: ChatTurnDto, second: number): ChatTurnDto => ({ ...turn, at: `2026-11-17T01:00:${String(second).padStart(2, '0')}.000Z` })
  const saved = [at(user('엔비디아 오늘 주가 알려줘'), 0), at(user('그냥 애플로 바꿔', true), 3), at(line('애플로 바꿔서 볼게요.', true), 4), at(line('지금 시세 확인할게요.'), 0), at(answer('애플은 228.10달러예요.'), 12)]
  expect(texts(askOrder(saved))).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 228.10달러예요.'])
  const later = [at(user('q'), 0), at(user('add', true), 3), at(line('adding', true), 4), at(line('reading the page'), 6), at(answer('both'), 12)]
  expect(texts(askOrder(later))).toEqual(['q', 'add', 'adding', 'reading the page', 'both'])
})

it('shows a reloaded room the same interim lines the live room showed, as the model wrote them, wherever the load window starts', async () => {
  const live = createCometThreads()
  live.begin('5', '견적서 세 건 금액 비교해줘')
  for (const text of ['Let me open the three quotes now.', '두 건은 다 봤어요.']) {
    live.handleEvent({ type: 'chat:token', channel: 'bot-5', text })
    live.handleEvent({ type: 'chat:token', channel: 'bot-5', text: '', reset: true })
  }
  live.handleEvent({ type: 'chat:token', channel: 'bot-5', text: 'B 업체가 제일 싸요.' })
  live.handleEvent({ type: 'chat:done', channel: 'bot-5', text: 'B 업체가 제일 싸요.' })
  const shownLive = live.thread('5').messages.map(message => message.text).filter(Boolean)
  expect(shownLive).toEqual(['견적서 세 건 금액 비교해줘', 'Let me open the three quotes now.', '두 건은 다 봤어요.', 'B 업체가 제일 싸요.'])
  const turn = [user('견적서 세 건 금액 비교해줘'), line('Let me open the three quotes now.'), line('두 건은 다 봤어요.'), answer('B 업체가 제일 싸요.')]
  const reloaded = createCometThreads()
  reloaded.load('5', turn)
  expect(reloaded.thread('5').messages.map(message => message.text)).toEqual(shownLive)
  const stored = [...turn, ...Array.from({ length: 397 }, (_, n) => n % 2 ? answer(`답 ${n}`) : user(`질문 ${n}`))].map((one, n) => ({ ...one, at: `t${String(n).padStart(4, '0')}` }))
  const paged = createCometThreads()
  paged.load('5', stored.slice(-400))
  expect(paged.thread('5').messages.slice(0, 3).map(message => message.text)).toEqual(['Let me open the three quotes now.', '두 건은 다 봤어요.', 'B 업체가 제일 싸요.'])
  expect(await paged.loadEarlier('5', async (_id, before, limit) => stored.slice(Math.max(0, stored.length - before - limit), stored.length - before))).toBe(1)
  expect(paged.thread('5').messages.slice(0, 4).map(message => message.text)).toEqual(shownLive)
})
