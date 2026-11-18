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

it('keeps a first line where it was shown: ask, first line, the change, the one-line reply, the answer', () => {
  const BOT = 'bot-order', channel = cometChannel(BOT)
  const said = (store: ReturnType<typeof createCometThreads>): string[] => store.thread(BOT).messages.map(m => m.text)
  const start = () => { const store = createCometThreads(BOT); store.begin(BOT, '엔비디아 오늘 주가 알려줘'); store.handleEvent({ type: 'chat:token', channel, text: '지금 시세 확인할게요.\n\n' }); return store }
  const live = start()
  live.noteUser(BOT, '그냥 애플로 바꿔', [], true)
  live.noteReply(BOT, '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.')
  expect(said(live)).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.'])
  live.handleEvent({ type: 'chat:token', channel, text: '', reset: true })
  expect(said(live)).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', ''])
  expect(live.thread(BOT).messages.at(-1)).toMatchObject({ role: 'assistant', streaming: true })
  live.handleEvent({ type: 'chat:done', channel, text: '애플은 11월 16일 종가 기준 228.10달러예요.' })
  expect(said(live)).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 11월 16일 종가 기준 228.10달러예요.'])
  const frozen = start()
  frozen.handleEvent({ type: 'chat:token', channel, text: '', reset: true })
  frozen.noteUser(BOT, '그냥 애플로 바꿔', [], true)
  frozen.noteReply(BOT, '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.')
  expect(said(frozen)).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', ''])
  const replaced = start()
  replaced.noteUser(BOT, '그냥 애플로 바꿔', [], true)
  replaced.noteReply(BOT, '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.')
  replaced.handleEvent({ type: 'chat:token', channel, text: '', reset: true, drop: true })
  replaced.handleEvent({ type: 'chat:done', channel, text: '애플은 228.10달러예요.' })
  expect(said(replaced)).toEqual(['엔비디아 오늘 주가 알려줘', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 228.10달러예요.'])
  const direct = start()
  direct.noteUser(BOT, '그냥 애플로 바꿔', [], true)
  direct.noteReply(BOT, '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.')
  direct.handleEvent({ type: 'chat:done', channel, text: '애플은 228.10달러예요.' })
  expect(said(direct)).toEqual(['엔비디아 오늘 주가 알려줘', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 228.10달러예요.'])
  const early = createCometThreads(BOT)
  early.begin(BOT, '서울 부산 제주 날씨')
  early.noteUser(BOT, '아 대구도 추가해', [], true)
  early.noteReply(BOT, '아 대구도 추가해', '대구도 넣을게요.')
  expect(said(early)).toEqual(['서울 부산 제주 날씨', '아 대구도 추가해', '대구도 넣을게요.', ''])
})

it('reads a saved first line back above the words said after it was shown, whenever a tool call froze it', () => {
  const at = (turn: ChatTurnDto, second: number): ChatTurnDto => ({ ...turn, at: `2026-11-17T01:00:${String(second).padStart(2, '0')}.000Z` })
  const saved = [at(user('엔비디아 오늘 주가 알려줘'), 0), at(user('그냥 애플로 바꿔', true), 3), at(line('애플로 바꿔서 볼게요.', true), 4), at(line('지금 시세 확인할게요.'), 0), at(answer('애플은 228.10달러예요.'), 12)]
  expect(texts(askOrder(saved))).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 228.10달러예요.'])
  const later = [at(user('q'), 0), at(user('add', true), 3), at(line('adding', true), 4), at(line('reading the page'), 6), at(answer('both'), 12)]
  expect(texts(askOrder(later))).toEqual(['q', 'add', 'adding', 'reading the page', 'both'])
})
