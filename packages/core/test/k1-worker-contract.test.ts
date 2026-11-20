import { expect, test } from 'vitest'
import { AUTO_REVIEW, handedData, settleMember, type MemberOutcome } from '../src/team-hire-tools.js'
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

test('a teammate\'s report block is read as written: each fact keeps its own words, page and day, a fact with no page takes the page that was read, and one with no words is left out', () => {
  const answer = '```report\n' + JSON.stringify({ facts: [{ text: '세션 예약은 앱에서만 받아요.', url: 'https://pool.example/book', site: '구민 수영장', date: '11월 23일' }, { text: '락커는 500원이에요.' }, { text: '  ', url: 'https://pool.example/blank' }, 'not a fact'], note: '요금표는 못 찾았어요.' }) + '\n```'
  const data = handedData(answer, {}, ['https://search.naver.com/search.naver?query=pool', 'https://pool.example/fees'], true)
  expect(data?.facts.map(f => [f.text, f.url, f.date])).toEqual([['세션 예약은 앱에서만 받아요.', 'https://pool.example/book', '11월 23일'], ['락커는 500원이에요.', 'https://pool.example/fees', undefined]])
  expect(data?.note).toBe('요금표는 못 찾았어요.')
  expect(handedData('```report\n{"facts":[{"text":"락커는 500원이에요."}]}\n```', {}, [])).toBeUndefined()
})

test('a report of nothing in the asked time keeps the newest thing seen under its short name, a writer\'s block gives its pieces in order, and words with no block are no data', () => {
  const none = handedData('{"facts":[],"nothing_in_period":{"latest":{"text":"봄 학기 강습 모집 안내","name":"봄 강습 모집","url":"https://pool.example/spring"}}}', {}, [])
  expect(none).toMatchObject({ facts: [], nothing: { latest: { text: '봄 학기 강습 모집 안내', name: '봄 강습 모집', url: 'https://pool.example/spring' } } })
  expect(handedData('{"facts":[],"nothing_in_period":{}}', {}, [])).toEqual({ facts: [], nothing: {} })
  expect(handedData('```report\n{"items":["첫 바퀴는 가볍게", "", "마지막 바퀴는 힘껏"]}\n```', { writer: true }, [])).toEqual({ facts: [], items: ['첫 바퀴는 가볍게', '마지막 바퀴는 힘껏'] })
  for (const words of ['자유 수영은 저녁 7시부터예요. https://pool.example/hours', '', '```report\n{"facts": [\n```', '[1, 2]', '{"facts":[]}']) expect(handedData(words, {}, ['https://pool.example/hours'])).toBeUndefined()
  expect(handedData('{"facts":[{"text":"자유 수영은 저녁 7시부터예요.","url":"https://pool.example/hours"}]}', { writer: true }, [])).toBeUndefined()
})
