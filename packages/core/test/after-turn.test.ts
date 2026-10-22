import { expect, it } from 'vitest'
import { afterTurnPrompt, parseAfterTurn } from '../src/after-turn.js'
import { NO_PROGRESS_LIMIT, progressWatch } from '../src/no-progress.js'

const added = ['부산도 같이 봐줘', '끝나면 두 도시 비교해서 한 줄로 정리해줘']

it('judges the added words and the job in one call', () => {
  const prompt = afterTurnPrompt('서울 이번 주 날씨 알려줘', added, '서울은 월 맑음 18°, 화 비 15°예요.')
  expect(prompt).toContain('1. 부산도 같이 봐줘')
  expect(prompt).toContain('Request: 서울 이번 주 날씨 알려줘')
  expect(prompt).toContain('a sign-in or login page')
  expect(prompt).toContain('"only_person"')
  expect(afterTurnPrompt('팀 현황 정리해줘', [], '오류가 떠서 못 했어요.')).toContain('(nothing)')
})

it('reads what was left and whether the job was done', () => {
  expect(parseAfterTurn('{"left":[2,1,2,7],"done":true}', added)).toEqual({ left: added, undone: null })
  expect(parseAfterTurn('```json\n{"left":[],"done":false,"blocked":"페이지 접속 오류"}\n```', added)).toEqual({ left: [], undone: { blocked: '페이지 접속 오류' } })
  expect(parseAfterTurn('{"done":false}', added)).toEqual({ left: [], undone: null })
  expect(parseAfterTurn('{"left":[],"done":false,"only_person":true,"blocked":"로그인 필요"}', added)).toEqual({ left: [], undone: null })
  expect(parseAfterTurn('{"left":[],"done":false,"only_person":false,"blocked":"페이지 오류"}', added)).toEqual({ left: [], undone: { blocked: '페이지 오류' } })
  expect(parseAfterTurn('no idea', added)).toEqual({ left: [], undone: null })
  expect(parseAfterTurn(null, added)).toEqual({ left: [], undone: null })
})

it('tells a turn going around in circles to stop and ask, and lets new findings reset it', () => {
  const watch = progressWatch(3)
  expect(watch.see('page A')).toBeNull()
  expect(watch.see('page B')).toBeNull()
  expect(watch.see('page A')).toBeNull()
  expect(watch.see('page  B ')).toBeNull()
  expect(watch.idle()).toBe(2)
  expect(watch.see('page A')).toContain('nothing new')
  expect(watch.see('page A')).toBeNull()
  expect(watch.see('page C')).toBeNull()
  expect(watch.idle()).toBe(0)
  expect(watch.see('page A')).toBeNull()
  expect(NO_PROGRESS_LIMIT).toBeGreaterThan(3)
})
