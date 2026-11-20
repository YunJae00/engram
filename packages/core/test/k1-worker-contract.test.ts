import { expect, test } from 'vitest'
import { AUTO_REVIEW, settleMember, type MemberOutcome } from '../src/team-hire-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'

const AT = '2026-11-20T02:00:00Z'
const hired = (over: Partial<TeamMember> = {}): TeamMember => ({ id: 'p1', parentId: null, depth: 1, role: '한결', brief: '동네 수영장 자유 수영 시간', state: 'working', sessionKey: 's', hiredAt: AT, lookup: true, botId: 'bot-p1', ...over })

test('a teammate outcome that carries a structured report settles as that report: its facts with their pages become the result, kept as data, and a lookup counts as reviewed', () => {
  const pool = hired()
  const outcome: MemberOutcome = { answer: '찾아왔어요.', sources: ['https://pool.example/hours'], report: { facts: [{ text: '자유 수영은 저녁 7시부터예요.', url: 'https://pool.example/hours', site: '구민 수영장' }, { text: '월요일은 쉬어요.', url: 'https://pool.example/closed', site: '구민 수영장', date: '11월 23일' }] } }
  settleMember(pool, outcome, AT, true)
  expect(pool.state).toBe('done')
  expect(pool.data).toEqual(outcome.report)
  expect(pool.result).toBe('자유 수영은 저녁 7시부터예요. — https://pool.example/hours\n월요일은 쉬어요 (11월 23일). — https://pool.example/closed')
  expect(pool.sources).toEqual(['https://pool.example/hours'])
  expect(pool.review).toEqual({ ok: true, note: AUTO_REVIEW })
  expect(pool.finishedAt).toBe(AT)
})

test('a report that says nothing is there for the asked time marks the part empty and names the newest thing seen; a writer\'s pieces are numbered', () => {
  const none = hired()
  settleMember(none, { answer: '', report: { facts: [], nothing: { latest: { text: '지난달 야간 개장 안내', url: 'https://pool.example/night', site: '구민 수영장' } } } }, AT, true)
  expect(none.empty).toBe(true)
  expect(none.result).toContain('가장 최근: 지난달 야간 개장 안내 — https://pool.example/night')
  const writer = hired({ lookup: undefined, writer: true })
  settleMember(writer, { answer: '', report: { facts: [], items: ['물살을 가르는 저녁', '퇴근길 한 바퀴'] } }, AT, true)
  expect(writer.result).toBe('1. 물살을 가르는 저녁\n2. 퇴근길 한 바퀴')
  expect(writer.review).toBeUndefined()
})

test('an empty report keeps the teammate\'s own words; no report, an error or a question settles on the plain path', () => {
  const blank = hired()
  settleMember(blank, { answer: '수영장 누리집이 열리지 않았어요.', report: null }, AT, true)
  expect(blank.state).toBe('done')
  expect(blank.data).toBeUndefined()
  expect(blank.result).toBe('수영장 누리집이 열리지 않았어요.')
  const plain = hired()
  settleMember(plain, { answer: '자유 수영은 저녁 7시부터예요. https://pool.example/hours', sources: ['https://pool.example/hours'] }, AT, true)
  expect(plain.data).toBeUndefined()
  expect(plain.result).toBe('자유 수영은 저녁 7시부터예요. https://pool.example/hours')
  const failed = hired()
  settleMember(failed, { answer: '', error: 'it was stopped.', report: { facts: [{ text: '쓰이지 않아요.', url: 'https://pool.example/x', site: 'x' }] } }, AT, true)
  expect(failed.state).toBe('failed')
  expect(failed.data).toBeUndefined()
  const asking = hired()
  settleMember(asking, { answer: '어느 지점인지 알려 주세요.', asked: true, report: null }, AT, true)
  expect(asking.state).toBe('waiting')
})
