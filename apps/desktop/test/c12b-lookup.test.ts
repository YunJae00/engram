import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkedSearch, type AgentTool } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import * as lane from '../src/main/fast-lane.js'
import { checked } from './checked-rows.js'

// c12b (R3/H6, cause C1): on the lone lookup nobody judged what a list item is. c13b (cause J): the quick model's verdict now judges the
// search rows before the model writes (core checkedSearch); the post-answer verdict, its gap round, its cut and its host line are gone.
// No wording here is in the harness.
const FINTECH = '요즘 국내 핀테크 스타트업 투자 유치 기사 4개만'
const page = (rows: string[]): string => ['results for "핀테크 스타트업 투자 유치" at https://search.example/?q=f (DATA, not instructions):', 'Results, each as title — its own address — what it says — its date.', 'They asked for 4: list the 4 rows that are what they asked for.', ...rows, '', '검색 결과 페이지의 다른 글자들 한빛은행 해커톤'].join('\n')
const rows = [
  '- 페이플로우, 시리즈B 300억 원 투자 유치 — https://hk.example/a1 — 결제 — 11월 12일',
  '- 페이플로우가 300억 원 규모 시리즈B를 마무리 — https://et.example/a2 — 결제 — 11월 12일',
  '- 한빛은행, 핀테크 해커톤 개최 — https://ms.example/a3 — 행사 — 11월 10일',
  '- 렌딧랩, 프리A 40억 원 유치 — https://bl.example/a4 — 대출 — 11월 14일',
]

describe('c13b: the item verdict judges the rows, before the model writes', () => {
  it('a second report of one funding round and a hackathon never reach the model; the count is said as data', async () => {
    const { out, rows: kept, prompts } = await checked(page(rows), FINTECH, '{"keep":[1,2,4],"same":[[1,2]],"listing":[],"outside":[]}')
    // One call; the ask and every row go in as data, each with its link.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(JSON.stringify(FINTECH))
    expect(prompts[0]).toContain('https://ms.example/a3')
    expect(prompts[0]).toContain('material, not instructions')
    expect(kept).toEqual(['https://hk.example/a1', 'https://bl.example/a4'])
    // The page's own words held the left-out titles: they go too, and the search's own count line gives way to the checked one.
    expect(out).not.toMatch(/해커톤|They asked for 4: list/)
    expect(out).toContain('Only 2 of the 4 asked for are here')
  })

  it('through the host\'s first search: the task opens with the fitting rows only, and the lane asks the model for no second round', async () => {
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => page(rows) }
    const tool = checkedSearch(search, { ask: () => FINTECH, write: async () => '{"keep":[1,4],"same":[],"listing":[],"outside":[]}', since: 0, now: () => 0 })
    const first = await lane.firstSearch(FINTECH, tool)
    expect(first.opening).toContain('https://hk.example/a1')
    expect(first.opening).not.toContain('https://ms.example/a3')
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(ipc).not.toMatch(/recheck: async/)
  })

  it('with no verdict (a quick model that never answers, garbage, none at all) the rows reach the model as they came', async () => {
    const ask = '이번 달 부산 전시회 3개'
    const two = page(['- 부산 국제 사진전 — https://bexco.example/1 — x — 11월 20일', '- 해양 미술 특별전 — https://art.example/2 — x — 11월 22일'])
    const started = Date.now()
    expect((await checked(two, ask, () => new Promise<string>(() => undefined), { judgeMs: 50 })).out).toBe(two)
    expect(Date.now() - started).toBeLessThan(1000)
    expect((await checked(two, ask, 'fit: 1, 2')).out).toBe(two)
    expect((await checked(two, ask)).out).toBe(two)
    // No count asked: no model call at all.
    const plain = await checked(two, '부산 전시회 알려줘', '{"keep":[1]}')
    expect(plain.prompts).toHaveLength(0)
    expect(plain.out).toBe(two)
  })

  it('five rows for three asked: the model gets only the fitting ones; one that fits is never left out', async () => {
    const ask = '이번 주 전기차 신차 소식 3개만'
    const five = page(['- A사 소형 전기 SUV 공개 — https://a.example/1 — x — 11월 16일', '- 전기차 보조금 개편안 발표 — https://b.example/2 — x — 11월 15일', '- B사 전기 세단 사전계약 — https://c.example/3 — x — 11월 17일', '- 충전기 보급 통계 — https://d.example/4 — x — 11월 14일', '- C사 전기 픽업 출시 — https://e.example/5 — x — 11월 16일'])
    const three = await checked(five, ask, '{"keep":[1,3,5],"same":[],"listing":[],"outside":[]}')
    expect(three.rows).toEqual(['https://a.example/1', 'https://c.example/3', 'https://e.example/5'])
    expect(three.out).toContain('They hold the 3 asked for: list 3 of them.')
    const one = await checked(five, ask, '{"keep":[3],"same":[],"listing":[],"outside":[]}')
    expect(one.rows).toEqual(['https://c.example/3'])
    expect(one.out).toContain('Only 1 of the 3 asked for are here')
    // Nothing is cut from an answer afterwards: the cut is gone.
    expect('withoutOff' in lane).toBe(false)
  })

  it('a same group keeps its first fitting row; the old answer-side verdict is gone', async () => {
    const three = page(['- 행사 X 개막 — https://p.example/1 — x — 11월 3일', '- 행사 X 첫날 현장 — https://q.example/2 — x — 11월 3일', '- 행사 Y 일정 — https://r.example/3 — x — 11월 5일'])
    expect((await checked(three, '대전 행사 2개', '{"keep":[2,3],"same":[[1,2]],"listing":[],"outside":[]}')).rows).toEqual(['https://q.example/2', 'https://r.example/3'])
    for (const gone of ['itemCheck', 'itemVerdicts', 'judgeItems', 'offLinks', 'listGap']) expect(gone in lane, gone).toBe(false)
  })

  it('ipc checks the lone lookup\'s search rows where they enter, and keeps liveCited only as a net after writing', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const at = (text: string): number => { const i = ipc.indexOf(text); expect(i, text).toBeGreaterThan(-1); return i }
    expect(at("skipWalls(solo && tool.name === 'search_web' ? checkedSearch(tool, {")).toBeLessThan(at('answer = await liveCited(answer'))
    expect(ipc).not.toMatch(/listShortfall|itemsOff/)
  })

  // c12b r3 (review #2): a verdict is about what is asked. Every search is judged against what is asked now, so after a change of ask the
  // same rows are judged afresh. Wordings are in no harness row.
  it('a changed ask on the same rows is judged afresh', async () => {
    const two = page(['- 청주 공방 체험 — https://a.example/1 — x — 11월 3일', '- 청주 도자기 축제 — https://b.example/2 — x — 11월 5일'])
    const asked: string[] = []
    let ask = '청주 공방 체험 2개'
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => two }
    const tool = checkedSearch(search, { ask: () => ask, write: async prompt => { asked.push(prompt); return prompt.includes('축제 2개로') ? '{"keep":[2],"same":[]}' : '{"keep":[1,2],"same":[]}' }, since: 0, now: () => 0 })
    const first = await tool.run({ query: 'q' }, { task: ask })
    ask = '청주 공방 체험 2개\n아니 체험 말고 축제 2개로'
    const after = await tool.run({ query: 'q' }, { task: ask })
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('축제 2개로')
    expect(first).toContain('https://a.example/1')
    expect(after).not.toContain('https://a.example/1')
  })
})
