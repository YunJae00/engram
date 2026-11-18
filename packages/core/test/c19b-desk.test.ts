import { expect, test } from 'vitest'
import { messageUnits, nounPhrase, repairedWrite, spliced, tidied, wellFormed, withoutSentences } from '../src/written-check.js'

const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
const none = JSON.stringify({ problems: [] })
const problems = (...list: Record<string, unknown>[]): string => JSON.stringify({ problems: list })
function model(answers: { check?: (string | undefined)[]; repair?: (string | undefined)[] }) {
  const calls: string[] = []
  const quick = async (prompt: string): Promise<string | undefined> => {
    calls.push(prompt)
    return prompt.includes(CHECK) ? answers.check?.shift() ?? none : prompt.includes(REPAIR) ? answers.repair?.shift() : undefined
  }
  return { quick, calls }
}
const fences = (text: string): number => text.split('\n').filter(line => /^\s*```/.test(line)).length
const REPLIES = ['```replies', '두부도 넣어줘', '양 좀 줄여줘', '```'].join('\n')
const LIST = ['장보기 목록만 뽑았어요.', '', '- 대파 한 단', '- 계란 한 판', '- 우유 1L', '', REPLIES].join('\n')

test('H2 reproduction: a repair of a quoted chip block never leaves an orphan fence', async () => {
  const blank = (draft: string): string => JSON.stringify({ replace: Object.fromEntries(messageUnits(draft).map((u, i) => [String(i + 1), u.text.includes('replies') || u.text.includes('줘') ? '' : u.text])) })
  const { quick } = model({ check: [problems({ kind: 'asks', quote: REPLIES, why: '선택지를 물어봄' })], repair: [blank(LIST)] })
  const out = await repairedWrite({ data: { source: '대파, 계란, 우유' }, ask: '장보기 목록만 뽑아줘', draft: LIST, check: quick, due: Date.now() + 20_000 })
  expect(fences(out.text) % 2).toBe(0)
  expect(out.text.endsWith(REPLIES)).toBe(true)
})

test('item 1: the opener, a chip line and the closer, each quoted in turn, come back byte-identical with no orphan fence', async () => {
  for (const quote of ['```replies', '두부도 넣어줘', '```']) {
    const everything = JSON.stringify({ replace: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), ''])) })
    for (const kind of ['asks', 'contradicts']) {
      const { quick, calls } = model({ check: [problems({ kind, quote, why: '' })], repair: [everything] })
      const out = await repairedWrite({ data: { source: '대파, 계란, 우유' }, ask: '장보기 목록만 뽑아줘', draft: LIST, check: quick, due: Date.now() + 20_000 })
      expect(out.text.endsWith(REPLIES)).toBe(true)
      expect(wellFormed(out.text)).toBe(true)
      expect(calls[0]).not.toContain('두부도 넣어줘')
    }
  }
  expect(messageUnits(LIST).map(u => u.text)).toEqual(['장보기 목록만 뽑았어요.', '- 대파 한 단', '- 계란 한 판', '- 우유 1L'])
})

test('item 1: a real code block between prose lines survives a repair and a removal of the prose around it', async () => {
  const draft = ['엑셀에서 이렇게 쓰면 돼요.', '```', '=SUMIF(A:A, "택배", B:B)', '```', '원하시면 다른 함수도 알려 드릴까요?', '합계 칸은 B열 아래에 두세요.'].join('\n')
  const units = messageUnits(draft)
  expect(units.map(u => u.text)).not.toContain('=SUMIF(A:A, "택배", B:B)')
  const fixed = spliced(draft, JSON.stringify({ replace: { '2': '' } }), new Set([1]))!
  expect(fixed).toBe(['엑셀에서 이렇게 쓰면 돼요.', '```', '=SUMIF(A:A, "택배", B:B)', '```', '합계 칸은 B열 아래에 두세요.'].join('\n'))
  expect(withoutSentences(draft, [{ kind: 'asks', quote: '원하시면 다른 함수도 알려 드릴까요?', why: '' }])).toBe(fixed)
  expect(spliced(draft, JSON.stringify({ replace: { '3': '합계 칸은 B열 아래예요.' }, insert_after: { '3': ['```'] } }), new Set([2]))).toBeUndefined()
})

test('item 2 (register, c18b r3 #1): a 동아리 회의 note whose only sentence is plain form is said as a noun phrase of its own words', async () => {
  const draft = '다음 주에 정한다.'
  const { quick } = model({ check: [problems({ kind: 'register', quote: draft, why: '한다체' })], repair: [undefined] })
  const out = await repairedWrite({ data: { source: '동아리 회의: 엠티 장소는 다음 회의 때 결정' }, ask: '동아리 회의 메모 정리해줘', draft, check: quick, due: Date.now() + 20_000 })
  expect(out.text).toBe('다음 주에 정함')
  expect(['먹는다', '끝났다', '부족하다', '회의는 월요일이다', '간다'].map(nounPhrase)).toEqual(['먹음', '끝났음', '부족함', '회의는 월요일임', '감'])
  expect(nounPhrase('그거 내가 할게')).toBeUndefined()
})

test('item 2 (register): a repair that writes a new plain-form sentence the draft did not have is refused, and the draft stands', async () => {
  const draft = '- 회비는 2만 원이에요.\n- 엠티는 11월 말에 가요.\n- 장소는 가평으로 확정됐다고 했어요.'
  const wrong = JSON.stringify({ replace: { '3': '장소는 미정이다.' } })
  const { quick } = model({
    check: [problems({ kind: 'contradicts', quote: '장소는 가평으로 확정됐다고 했어요.', why: '장소 미정' }), problems({ kind: 'register', quote: '장소는 미정이다.', why: '한다체' })],
    repair: [wrong],
  })
  const out = await repairedWrite({ data: { source: '회비 2만 원, 엠티 11월 말, 장소 미정' }, ask: '동아리 공지 요약해줘', draft, check: quick, due: Date.now() + 20_000 })
  expect(out.text).not.toContain('미정이다')
  expect(out.outcome).not.toBe('repaired')
  expect(out.text).toBe('- 회비는 2만 원이에요.\n- 엠티는 11월 말에 가요.')
})

test('a register-only repair that keeps the plain ending is refused without a re-check, and a real one is kept', async () => {
  for (const [draft, still, source] of [['회비는 만 원이다.', '회비는 이번에도 만 원이다.', '회비 1만원'], ['집합 시간은 아침 7시였다.', '집합 시간은 원래 아침 7시였다.', '집합 7시']] as const) {
    const { quick, calls } = model({ check: [problems({ kind: 'register', quote: draft, why: '한다체' })], repair: [JSON.stringify({ replace: { '1': still } })] })
    const out = await repairedWrite({ data: { source }, ask: '동아리 공지 한 줄 써줘', draft, check: quick, due: Date.now() + 20_000 })
    expect(out.text, draft).not.toBe(still)
    expect(out.text.endsWith('다') || out.text.endsWith('다.'), out.text).toBe(false)
    expect(calls.filter(p => p.includes(CHECK))).toHaveLength(1)
  }
  const { quick } = model({ check: [problems({ kind: 'register', quote: '회비는 만 원이다.', why: '한다체' })], repair: [JSON.stringify({ replace: { '1': '회비는 만 원이에요.' } })] })
  expect((await repairedWrite({ data: { source: '회비 1만원' }, ask: '동아리 공지 한 줄 써줘', draft: '회비는 만 원이다.', check: quick, due: Date.now() + 20_000 })).text).toBe('회비는 만 원이에요.')
})

test('a repair, a removal and a register change leave a code block\'s blank lines as they were', async () => {
  const CODE = ['```python', 'import csv', '', '', '', 'print(total)', '```'].join('\n')
  const draft = ['합계를 내는 코드예요.', '', '', '', CODE, '', '돌리면 합계가 나와요. 결과는 바로 보인다.'].join('\n')
  const fixed = spliced(draft, JSON.stringify({ replace: { '1': '합계 코드예요.' } }), new Set([0]))!
  expect(fixed).toContain(CODE)
  expect(fixed.startsWith('합계 코드예요.\n\n```python')).toBe(true)
  expect(withoutSentences(draft, [{ kind: 'asks', quote: '결과는 바로 보인다.', why: '' }])).toContain(CODE)
  const { quick } = model({ check: [problems({ kind: 'register', quote: '결과는 바로 보인다.', why: '한다체' })], repair: [undefined] })
  expect((await repairedWrite({ data: { source: 'x' }, ask: '합계 코드 줘', draft, check: quick, due: Date.now() + 20_000 })).text).toContain(CODE)
  expect(tidied(`a\n\n\n\nb\n${CODE}`)).toBe(`a\n\nb\n${CODE}`)
})
