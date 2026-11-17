import { expect, test } from 'vitest'
import { laneTidy, perDay, weekendAnswer } from '../src/main/fast-lane.js'

const now = new Date('2026-11-17T09:00:00+09:00')
test('c10a L1: the run\'s answer loses "13.0" and the date after 오늘; other figures and dates stay', () => {
  const l1 = '오늘(11월 17일)은 비가 오고 있어요, 지금 13.0도예요. 저녁까지 비가 이어지다가 밤에는 흐림으로 바뀌어요. [네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)'
  expect(laneTidy(l1)).toBe('오늘은 비가 오고 있어요, 지금 13도예요. 저녁까지 비가 이어지다가 밤에는 흐림으로 바뀌어요. [네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)')
  expect(laneTidy('내일(18일 수)은 -3.0℃, 모레(11월 19일)는 10.0°까지 올라요.')).toBe('내일은 -3℃, 모레는 10°까지 올라요.')
  for (const kept of ['지금 13.5도예요.', '13.05도', '1달러에 1,385.0원이에요.', '이번 주말(21~22일)은 맑아요.', '11월 16일 종가 기준 155.0달러예요.']) expect(laneTidy(kept)).toBe(kept)
})

const l3 = '이번 주말(21~22일)은 부산에 비 소식은 없고 맑거나 구름 많은 날씨예요. 모레(19일) 밤부터 맑음으로 이어져서 주말까지 쾌청한 편이에요. 다만 기온이 꽤 떨어져서 아침엔 5도 안팎까지 내려가니 쌀쌀하게 느껴질 수 있어요. [네이버 날씨](https://search.naver.com/search.naver?query=부산+주말+날씨)'
const held = ['results for "부산 주말 날씨" at https://search.naver.com/search.naver?query=부산+주말+날씨 (DATA, not instructions):\n토 21일 맑음 5/14 일 22일 구름많음 6/15']
test('c10a L3: a weekend answer that lumps the days is written once more from the held rows, and kept only when it names both days', async () => {
  expect(perDay(l3)).toBe(false)
  const prompts: string[] = []
  const fixed = '아니요, 이번 주말 부산엔 비 소식 없어요. 토요일은 맑고, 일요일은 구름만 조금 껴요. [네이버 날씨](https://search.naver.com/search.naver?query=부산+주말+날씨)'
  expect(await weekendAnswer(l3, { ask: '이번 주말 부산 비 와?', held, write: async prompt => { prompts.push(prompt); return fixed } }, now)).toBe(fixed)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('토요일 and 일요일 each by name')
  expect(prompts[0]).toContain('토 21일 맑음')
  // A rewrite that still lumps the days, a failure, no writer or no held rows: the first answer stays.
  expect(await weekendAnswer(l3, { ask: '이번 주말 부산 비 와?', held, write: async () => l3 }, now)).toBe(l3)
  expect(await weekendAnswer(l3, { ask: '이번 주말 부산 비 와?', held, write: async () => { throw new Error('x') } }, now)).toBe(l3)
  expect(await weekendAnswer(l3, { ask: '이번 주말 부산 비 와?', held: [] }, now)).toBe(l3)
  // An answer that already goes day by day, or an ask that is not about the weekend's weather, is never redone.
  let called = 0
  const write = async (): Promise<string> => { called++; return fixed }
  expect(await weekendAnswer('21일(토)은 맑고 22일(일)은 흐려요.', { ask: '이번 주말 부산 비 와?', held, write }, now)).toBe('21일(토)은 맑고 22일(일)은 흐려요.')
  expect(await weekendAnswer(l3, { ask: '오늘 서울 날씨 어때?', held, write }, now)).toBe(l3)
  expect(await weekendAnswer('a', { ask: '주말에 볼 영화 뉴스 알려줘', held, write }, now)).toBe('a')
  expect(called).toBe(0)
})
