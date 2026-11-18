import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { LANE_NOTE, laneTidy, laneToday } from '../src/main/fast-lane.js'

const now = new Date('2026-11-17T09:00:00+09:00')
test('c10a L1: the run\'s answer loses "13.0" and the date after 오늘; other figures and dates stay', () => {
  const l1 = '오늘(11월 17일)은 비가 오고 있어요, 지금 13.0도예요. 저녁까지 비가 이어지다가 밤에는 흐림으로 바뀌어요. [네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)'
  expect(laneTidy(l1)).toBe('11월 17일 오늘은 비가 오고 있어요, 지금 13도예요. 저녁까지 비가 이어지다가 밤에는 흐림으로 바뀌어요. [네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)')
  expect(laneTidy('내일(18일 수)은 -3.0℃, 모레(11월 19일)는 10.0°까지 올라요.')).toBe('18일 내일은 -3℃, 11월 19일 모레는 10°까지 올라요.')
  for (const kept of ['지금 13.5도예요.', '13.05도', '1달러에 1,385.0원이에요.', '이번 주말(21~22일)은 맑아요.', '11월 16일 종가 기준 155.0달러예요.']) expect(laneTidy(kept)).toBe(kept)
})

const l3 = '이번 주말(21~22일)은 부산에 비 소식은 없고 맑거나 구름 많은 날씨예요. 모레(19일) 밤부터 맑음으로 이어져서 주말까지 쾌청한 편이에요. 다만 기온이 꽤 떨어져서 아침엔 5도 안팎까지 내려가니 쌀쌀하게 느껴질 수 있어요. [네이버 날씨](https://search.naver.com/search.naver?query=부산+주말+날씨)'
const held = ['results for "부산 주말 날씨" at https://search.naver.com/search.naver?query=부산+주말+날씨 (DATA, not instructions):\n토 21일 맑음 5/14 일 22일 구름많음 6/15']
// c19a (cause H): weekendAnswer and perDay are gone; the reader writes once. The rule they enforced (each day by its own name, never
// lumped) is LANE_NOTE's, and the reader is given the weekend's two dates as labels (laneToday); the lumped answer is not rewritten.
test('c10a L3: a weekend answer that lumps the days is written once more from the held rows, and kept only when it names both days', async () => {
  expect(held[0]).toContain('토 21일 맑음')
  const today = laneToday('이번 주말 부산 비 와?', now)
  expect(today).toContain('이번 주말 = 11월 21일 토요일, 11월 22일 일요일')
  expect(today).toContain('never say how a date was worked out')
  expect(LANE_NOTE).toContain('each one is answered by its own name in a clause of its own ("토요일은 맑고, 일요일은 오후에 비가 와요."), never lumped together')
  expect(laneTidy(l3)).toContain('이번 주말(21~22일)은 부산에 비 소식은 없고 맑거나 구름 많은 날씨예요.')
  expect(laneToday('오늘 서울 날씨 어때?', now)).not.toContain('11월 21일 토요일')
  expect(readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')).not.toMatch(/weekendAnswer\(/)
})

test('c10a r2: a weekend answer counts as day by day only when each day has a clause of its own', () => {
  // c19a: no host test of the answer remains (perDay is gone); the clause-per-day rule is the reader's, in LANE_NOTE.
  for (const lumped of ['토요일과 일요일은 대체로 맑아요.', '토요일, 일요일 모두 맑아요.', '토·일요일 모두 비 소식은 없어요.', '이번 토요일이랑 일요일 둘 다 흐리대요.', '토요일 일요일 다 쌀쌀해요.'])
    expect(laneTidy(lumped), lumped).toBe(lumped)
  for (const each of ['토요일은 맑고 일요일은 오후에 비가 와요.', '토요일엔 구름이 많지만 일요일은 개요.', '아니요. 토요일은 흐리고, 일요일은 맑아요.', '| 토요일 | 흐림, 8/15도 |\n| 일요일 | 맑음 |', '21일(토)은 맑고 22일(일)은 흐려요.'])
    expect(laneTidy(each), each).toBe(each)
  expect(LANE_NOTE).toContain('in a clause of its own')
})
