import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { runComet, type Engine } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'
import * as lane from '../src/main/fast-lane.js'
import { LANE_NOTE, LANE_SOLO_CALLS, LANE_SOLO_SOFT_MS, laneToday } from '../src/main/fast-lane.js'

const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
const posted = async (draft: string): Promise<string> => (await runComet({ engine: { id: 'claude', runTools: async () => ({ answer: draft }) } as unknown as Engine, workdir: '.' as never, tools: [] }, '토요일 일요일 통영 우산 챙겨야 해?', { guided: false, modelHint: 'smart', lookup: true, maxCalls: LANE_SOLO_CALLS, deadlineMs: LANE_SOLO_SOFT_MS, attachmentContext: LANE_NOTE })).answer

const now = new Date('2026-11-17T09:00:00+09:00')
test('c10a L1: the run\'s answer is posted with its "13.0" and its bracketed date as written; whole degrees and plain dates are rules the model reads', async () => {
  const l1 = '오늘(11월 17일)은 비가 오고 있어요, 지금 13.0도예요. 저녁까지 비가 이어지다가 밤에는 흐림으로 바뀌어요. [네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)'
  for (const kept of [l1, '내일(18일 수)은 -3.0℃, 모레(11월 19일)는 10.0°까지 올라요.', '지금 13.5도예요.', '13.05도', '1달러에 1,385.0원이에요.', '이번 주말(21~22일)은 맑아요.', '11월 16일 종가 기준 155.0달러예요.']) expect(await posted(kept)).toBe(kept)
  expect(Object.keys(lane).filter(key => typeof (lane as Record<string, unknown>)[key] === 'function').sort()).toEqual(['asideShape', 'askedDays', 'fastLane', 'firstSearch', 'laneFirstLine', 'laneQuery', 'laneToday', 'quickQuestion', 'shortAsk', 'shortQuestion', 'swapRounds', 'swappedAsk', 'teamAsk'])
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
  expect(LANE_NOTE).toContain('a temperature in whole degrees when it ends in .0')
  expect(COLLEAGUE_CORE_RULE).toContain('a whole number has no ".0", and a day is said with its date in plain words, never in brackets')
})

const l3 = '이번 주말(21~22일)은 부산에 비 소식은 없고 맑거나 구름 많은 날씨예요. 모레(19일) 밤부터 맑음으로 이어져서 주말까지 쾌청한 편이에요. 다만 기온이 꽤 떨어져서 아침엔 5도 안팎까지 내려가니 쌀쌀하게 느껴질 수 있어요. [네이버 날씨](https://search.naver.com/search.naver?query=부산+주말+날씨)'
const held = ['results for "부산 주말 날씨" at https://search.naver.com/search.naver?query=부산+주말+날씨 (DATA, not instructions):\n토 21일 맑음 5/14 일 22일 구름많음 6/15']
test('c10a L3: a weekend answer that lumps the days is posted as the model wrote it; naming each day is asked of the model before it writes', async () => {
  expect(held[0]).toContain('토 21일 맑음')
  const today = laneToday('이번 주말 부산 비 와?', now)
  expect(today).toContain('이번 주말 = 11월 21일 토요일, 11월 22일 일요일')
  expect(today).toContain('never say how a date was worked out')
  expect(LANE_NOTE).toContain('each one is answered by its own name in a clause of its own ("토요일은 맑고, 일요일은 오후에 비가 와요."), never lumped together')
  expect(await posted(l3)).toBe(l3)
  expect(laneToday('오늘 서울 날씨 어때?', now)).not.toContain('11월 21일 토요일')
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
})

test('c10a r2: a weekend answer is never rewritten, lumped or day by day; a clause for each day is the note\'s rule', async () => {
  for (const lumped of ['토요일과 일요일은 대체로 맑아요.', '토요일, 일요일 모두 맑아요.', '토·일요일 모두 비 소식은 없어요.', '이번 토요일이랑 일요일 둘 다 흐리대요.', '토요일 일요일 다 쌀쌀해요.'])
    expect(await posted(lumped), lumped).toBe(lumped)
  for (const each of ['토요일은 맑고 일요일은 오후에 비가 와요.', '토요일엔 구름이 많지만 일요일은 개요.', '아니요. 토요일은 흐리고, 일요일은 맑아요.', '| 토요일 | 흐림, 8/15도 |\n| 일요일 | 맑음 |', '21일(토)은 맑고 22일(일)은 흐려요.'])
    expect(await posted(each), each).toBe(each)
  expect(LANE_NOTE).toContain('in a clause of its own')
})
