import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { messageUnits, wellFormed } from 'core'
import { checkedDesk, onceEach, reshapeAsk, withPart, withoutQuoted } from '../src/main/desk-lane.js'

const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it'
const quickOf = (check: (string | undefined)[], repair: (string | undefined)[]) => {
  const prompts: string[] = []
  return { prompts, quick: async (p: string) => { prompts.push(p); return p.includes(CHECK) ? check.shift() ?? '{"problems":[]}' : p.includes(REPAIR) ? repair.shift() : undefined } }
}
const problems = (...list: Record<string, unknown>[]): string => JSON.stringify({ problems: list })

describe('item 1: a desk answer\'s ```replies block is not prose', () => {
  const REPLIES = ['```replies', '두부도 넣어줘', '양 좀 줄여줘', '```'].join('\n')
  const SOURCE = '장보기: 대파 한 단, 계란 한 판, 우유 1L, 두부'
  const DRAFT = ['장보기 목록만 뽑았어요.', '', '- 대파 한 단', '- 계란 한 판', '- 우유 1L', '', REPLIES].join('\n')
  it('the H2 shape (the check quotes the whole block as "asks") leaves the block byte-identical, on the desk check\'s own removal path too', async () => {
    for (const quote of [REPLIES, '```replies', '두부도 넣어줘', '```']) {
      const blank = JSON.stringify({ replace: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), ''])) })
      const { quick } = quickOf([problems({ kind: 'asks', quote, why: '선택지' })], [blank])
      const out = await checkedDesk({ ask: '장보기 목록만 뽑아줘', draft: DRAFT, source: SOURCE, fromSource: true, quick, since: Date.now() })
      expect(out.endsWith(REPLIES), quote).toBe(true)
      expect(wellFormed(out)).toBe(true)
      expect(withoutQuoted(DRAFT, [{ kind: 'asks', quote, why: '' }])).toContain(REPLIES)
    }
  })
  it('a missing part is added above the trailing block, never after it', () => {
    const out = withPart(DRAFT, { quote: '같이 살 것', lines: ['두부'] }, SOURCE)
    expect(out.endsWith(`같이 살 것\n- 두부\n\n${REPLIES}`)).toBe(true)
  })
})

describe('item 2: a repair never copies a source line under a second part', () => {
  const SOURCE = ['# 하반기 워크숍 회의록', '', '## 결정', '- 워크숍 장소는 양평 연수원으로 확정', '- 1박 2일 일정으로 진행', '',
    '## 업무', '- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일'].join('\n')
  const ASK = '워크숍 회의록에서 결정이랑 담당 업무 나눠서 정리해줘'
  const DRAFT = ['워크숍 회의 정리했어요.', '', '결정', '- 워크숍 장소는 양평 연수원으로 확정', '- 1박 2일 일정으로 진행', '- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일'].join('\n')
  const TASKS = ['- 숙소 예약 — 윤서아, 11월 25일', '- 버스 대절 견적 — 마도윤, 11월 27일', '- 프로그램 초안 — 강예린, 12월 1일']
  const reworded = ['- 윤서아 님이 숙소 예약을 11월 25일까지 해요', '- 마도윤 님이 버스 대절 견적을 11월 27일까지 받아요', '- 강예린 님이 프로그램 초안을 12월 1일까지 써요']
  it('the reworded copy is refused and every task line stands once, under 담당 업무', async () => {
    const units = messageUnits(DRAFT)
    const copy = JSON.stringify({ insert_after: { [String(units.length)]: ['', '담당 업무', ...reworded] } })
    const { quick } = quickOf([problems({ kind: 'missing', quote: '담당 업무', why: '없음', lines: TASKS })], [copy])
    const out = await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, fromSource: true, quick, since: Date.now() })
    expect(out).not.toContain('님이')
    for (const task of TASKS) expect(out.split('\n').filter(line => line === task)).toHaveLength(1)
    const [decided, tasks] = out.split('담당 업무')
    expect(TASKS.every(task => tasks!.includes(task) && !decided!.includes(task))).toBe(true)
    expect(onceEach(out, SOURCE)).toBe(true)
  })
  it('onceEach tells a reworded copy from two different lines', () => {
    expect(onceEach([...TASKS, ...reworded].join('\n'), SOURCE)).toBe(false)
    expect(onceEach(TASKS.join('\n'), SOURCE)).toBe(true)
  })
})

describe('item 3: a shorter reshape that passed the form test goes out as written', () => {
  const ASK = '택배 늦어서 미안하다는 문자 한 줄 써줘'
  const LAST = '고객님, 택배 배송이 늦어져서 정말 죄송합니다. 최대한 빨리 받아보실 수 있도록 하겠습니다.'
  it('one call for the draft, no meaning round, and a scripted rewrite to the original is never used', async () => {
    const short = '택배가 늦어져 죄송합니다. 곧 받아보시게 할게요.'
    const calls: string[] = []
    const quick = async (prompt: string): Promise<string> => {
      calls.push(prompt)
      if (prompt.includes(CHECK)) return problems({ kind: 'dropped', quote: short, why: '' })
      if (prompt.includes(REPAIR)) return JSON.stringify({ replace: { '1': LAST } })
      return JSON.stringify({ form: 'shorter', was: LAST, reply: short })
    }
    expect(await reshapeAsk('좀 더 줄여줘', LAST, quick, ASK)).toBe(short)
    expect(calls).toHaveLength(1)
    expect(calls.some(p => p.includes(REPAIR))).toBe(false)
  })
  it('on the Q4 latencies (1.7 s draft) the reshape ends under 4 s with at most 2 calls left for the turn', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const quick = (): Promise<string> => { calls++; return new Promise(resolve => setTimeout(() => resolve(JSON.stringify({ form: 'shorter', was: LAST, reply: '배송 늦어 죄송해요.' })), 1700)) }
      const began = Date.now(), out = reshapeAsk('좀 더 줄여줘', LAST, quick, ASK)
      await vi.advanceTimersByTimeAsync(1700)
      expect(await out).toBe('배송 늦어 죄송해요.')
      expect(Date.now() - began).toBeLessThan(4000)
      expect(calls).toBeLessThanOrEqual(2)
    } finally { vi.useRealTimers() }
  })
  it('a draft that was not shorter takes the usual route', async () => {
    const quick = async (): Promise<string> => JSON.stringify({ form: 'shorter', was: LAST, reply: `${LAST} 감사합니다.` })
    expect(await reshapeAsk('좀 더 줄여줘', LAST, quick, ASK)).toBeUndefined()
  })
  it('another form keeps the meaning check, and its repair must keep the form: a rewrite back to the last reply is refused', async () => {
    const polite = '택배 배송이 늦어져 정말 죄송해요. 최대한 빨리 받아보시게 할게요.'
    const { quick, prompts } = quickOf([problems({ kind: 'dropped', quote: '택배 배송이 늦어져 정말 죄송해요.', why: '' })], [JSON.stringify({ replace: { '1': LAST.split('. ')[0] + '.', '2': '최대한 빨리 받아보실 수 있도록 하겠습니다.' } })])
    const voice = async (p: string): Promise<string> => p.includes(CHECK) || p.includes(REPAIR) ? (await quick(p)) ?? '' : JSON.stringify({ form: 'tone', was: LAST, reply: polite })
    expect(await reshapeAsk('좀 부드럽게', LAST, voice, ASK)).toBeUndefined()
    expect(prompts.some(p => p.includes(CHECK))).toBe(true)
  })
})
