import { describe, expect, it } from 'vitest'
import { noteBodyIn } from '../src/comet-tools.js'

// A title typed into a blank points at a note; what belongs in the blank is
// what that note says.
const READ = [
  '[오늘 한 일] (id: n-1) 리플레이어와 제출 승인 게이트를 끝냈다. 메모리 게이트도 고쳤다. [집에서 할 일] (id: n-2) 수요일까지 자동차 보험 갱신하기.',
  'More than one of these may bear on it: use what you need from all of them.',
].join(' ')

describe('noteBodyIn', () => {
  it('turns a title into the words of its note', () => {
    expect(noteBodyIn(READ, '오늘 한 일')).toBe('리플레이어와 제출 승인 게이트를 끝냈다. 메모리 게이트도 고쳤다.')
    expect(noteBodyIn(READ, '집에서 할 일')).toBe('수요일까지 자동차 보험 갱신하기.')
  })
  it('leaves words that are not a title alone', () => {
    expect(noteBodyIn(READ, '업무일지 올리기')).toBeNull()
    expect(noteBodyIn(READ, '')).toBeNull()
    expect(noteBodyIn('nothing printed yet', '오늘 한 일')).toBeNull()
  })
})
