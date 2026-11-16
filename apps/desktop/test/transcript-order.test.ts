import { expect, it } from 'vitest'
import { askOrder } from '../src/renderer/src/lib/transcriptOrder.js'
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
