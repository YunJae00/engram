import { expect, it } from 'vitest'
import { askOrder } from '../src/renderer/src/lib/transcriptOrder.js'
import { cometChannel, createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import type { ChatTurnDto } from '../src/shared/types.js'

const user = (text: string, aside = false): ChatTurnDto => ({ role: 'user', text, ...(aside ? { aside } : {}) })
const answer = (text: string): ChatTurnDto => ({ role: 'assistant', text })
const line = (text: string, aside = false): ChatTurnDto => ({ role: 'assistant', text, progress: true, ...(aside ? { aside } : {}) })
const texts = (list: ChatTurnDto[]): string[] => list.map(turn => turn.text)

// grokbar c3 T1/T2 (GROKBOT rule 3): the person's "아 대구도 추가해" and "그냥 애플로 바꿔" were drawn after the answer that already covered them.
it('leaves words the running turn absorbed where they were said, above the one answer that covers them', () => {
  const saved = [user('three cities'), line('splitting it up'), user('add Daegu', true), line('adding Daegu', true), answer('four cities')]
  expect(texts(askOrder(saved))).toEqual(['three cities', 'splitting it up', 'add Daegu', 'adding Daegu', 'four cities'])
  // Two messages, one answer: both absorbed.
  expect(texts(askOrder([user('q'), user('a1', true), user('a2', true), answer('one answer')]))).toEqual(['q', 'a1', 'a2', 'one answer'])
  // Nothing answered yet (the turn still runs): in place.
  expect(texts(askOrder([user('q'), line('ack'), user('a1', true)]))).toEqual(['q', 'ack', 'a1'])
  // A stop sits above its one line.
  expect(texts(askOrder([user('q'), user('stop', true), answer('stopped')]))).toEqual(['q', 'stop', 'stopped'])
})

it('shows words that got a turn of their own after the running turn\'s answer, their reply line with them', () => {
  // The turn answered its own ask, then the words were answered separately: each reply sits under its question.
  expect(texts(askOrder([user('count to thirty'), user('only the even ones', true), answer('1..30'), answer('2, 4, ..')]))).toEqual(['count to thirty', '1..30', 'only the even ones', '2, 4, ..'])
  expect(texts(askOrder([user('q'), user('a1', true), line('on it', true), answer('ans q'), answer('ans a1'), user('next'), answer('ans next')])))
    .toEqual(['q', 'ans q', 'a1', 'on it', 'ans a1', 'next', 'ans next'])
  // Two messages, three answers: each got its own.
  expect(texts(askOrder([user('q'), user('a1', true), user('a2', true), answer('ans q'), answer('ans a1'), answer('ans a2')]))).toEqual(['q', 'ans q', 'a1', 'ans a1', 'a2', 'ans a2'])
  // Two messages, two answers: the first was absorbed, the last got its own turn.
  expect(texts(askOrder([user('q'), user('a1', true), user('a2', true), answer('ans q+a1'), answer('ans a2')]))).toEqual(['q', 'a1', 'ans q+a1', 'a2', 'ans a2'])
})

it('hands words whose answer is on a newer page back to the caller', () => {
  const late: ChatTurnDto[] = []
  expect(texts(askOrder([user('q'), answer('a'), user('q2'), user('edge', true)], late))).toEqual(['q', 'a', 'q2'])
  expect(texts(late)).toEqual(['edge'])
  // Within the page the same rule holds.
  const none: ChatTurnDto[] = []
  expect(texts(askOrder([user('q'), user('add', true), answer('both'), user('q2'), answer('a2')], none))).toEqual(['q', 'add', 'both', 'q2', 'a2'])
  expect(none).toEqual([])
})

// grokbar c4 T2: "엔비디아 오늘 주가 알려줘" / "그냥 애플로 바꿔" / "애플로 바꿔서 볼게요." / "지금 시세 확인할게요." / answer: the lookup's own
// first line, on screen at 0.1 s, was frozen under the reply to words said after it, and read as a second acknowledgement.
it('keeps a first line where it was shown: ask, first line, the change, the one-line reply, the answer', () => {
  const BOT = 'bot-order', channel = cometChannel(BOT)
  const said = (store: ReturnType<typeof createCometThreads>): string[] => store.thread(BOT).messages.map(m => m.text)
  const start = () => { const store = createCometThreads(BOT); store.begin(BOT, '엔비디아 오늘 주가 알려줘'); store.handleEvent({ type: 'chat:token', channel, text: '지금 시세 확인할게요.\n\n' }); return store }
  // The words come while the first line is still the live text; a tool call then freezes it.
  const live = start()
  live.noteUser(BOT, '그냥 애플로 바꿔', [], true)
  live.noteReply(BOT, '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.')
  expect(said(live)).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.'])
  live.handleEvent({ type: 'chat:token', channel, text: '', reset: true })
  expect(said(live)).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', ''])
  expect(live.thread(BOT).messages.at(-1)).toMatchObject({ role: 'assistant', streaming: true })
  live.handleEvent({ type: 'chat:done', channel, text: '애플은 11월 16일 종가 기준 228.10달러예요.' })
  expect(said(live)).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 11월 16일 종가 기준 228.10달러예요.'])
  // The line was already frozen when the words came: the same order (T1's path, unchanged).
  const frozen = start()
  frozen.handleEvent({ type: 'chat:token', channel, text: '', reset: true })
  frozen.noteUser(BOT, '그냥 애플로 바꿔', [], true)
  frozen.noteReply(BOT, '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.')
  expect(said(frozen)).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.\n\n', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', ''])
  // A waiting line the answer replaces is not kept: the bubble moves under the words, so the answer is still last.
  const replaced = start()
  replaced.noteUser(BOT, '그냥 애플로 바꿔', [], true)
  replaced.noteReply(BOT, '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.')
  replaced.handleEvent({ type: 'chat:token', channel, text: '', reset: true, drop: true })
  replaced.handleEvent({ type: 'chat:done', channel, text: '애플은 228.10달러예요.' })
  expect(said(replaced)).toEqual(['엔비디아 오늘 주가 알려줘', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 228.10달러예요.'])
  // No tool call and no drop before the answer lands in the bubble: the answer goes under the words too.
  const direct = start()
  direct.noteUser(BOT, '그냥 애플로 바꿔', [], true)
  direct.noteReply(BOT, '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.')
  direct.handleEvent({ type: 'chat:done', channel, text: '애플은 228.10달러예요.' })
  expect(said(direct)).toEqual(['엔비디아 오늘 주가 알려줘', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 228.10달러예요.'])
  // Words before any line is on screen stay above the answer still to come, as before.
  const early = createCometThreads(BOT)
  early.begin(BOT, '서울 부산 제주 날씨')
  early.noteUser(BOT, '아 대구도 추가해', [], true)
  early.noteReply(BOT, '아 대구도 추가해', '대구도 넣을게요.')
  expect(said(early)).toEqual(['서울 부산 제주 날씨', '아 대구도 추가해', '대구도 넣을게요.', ''])
})

it('reads a saved first line back above the words said after it was shown, whenever a tool call froze it', () => {
  const at = (turn: ChatTurnDto, second: number): ChatTurnDto => ({ ...turn, at: `2026-11-17T01:00:${String(second).padStart(2, '0')}.000Z` })
  // Saved in the order written: the words (3 s), their reply (4 s), then the first line, frozen at 6 s but shown at 0 s.
  const saved = [at(user('엔비디아 오늘 주가 알려줘'), 0), at(user('그냥 애플로 바꿔', true), 3), at(line('애플로 바꿔서 볼게요.', true), 4), at(line('지금 시세 확인할게요.'), 0), at(answer('애플은 228.10달러예요.'), 12)]
  expect(texts(askOrder(saved))).toEqual(['엔비디아 오늘 주가 알려줘', '지금 시세 확인할게요.', '그냥 애플로 바꿔', '애플로 바꿔서 볼게요.', '애플은 228.10달러예요.'])
  // A line first shown after the words stays under them.
  const later = [at(user('q'), 0), at(user('add', true), 3), at(line('adding', true), 4), at(line('reading the page'), 6), at(answer('both'), 12)]
  expect(texts(askOrder(later))).toEqual(['q', 'add', 'adding', 'reading the page', 'both'])
})
