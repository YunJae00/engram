import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runToolSession, type AgentTool, type Engine, type EngineCwd, type ToolSessionJob, type ToolSessionResult } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { itemCheck, itemVerdicts, judgeItems, listGap, listItems, listShortfall, offLinks, withoutOff } from '../src/main/fast-lane.js'

// c12b (R3/H6, cause C1): on the lone lookup nobody judged what a list item is. One quick-model verdict now judges each item against the
// ask and groups items about one same event; its misses feed the existing gap → one-more-round path. No wording here is in the harness.
const NOW = new Date('2026-11-18T10:00:00+09:00')
const FINTECH = '요즘 국내 핀테크 스타트업 투자 유치 기사 4개만'
const draft = [
  '1. 페이플로우, 시리즈B 300억 원 투자 유치 (11월 12일) — [한국경제](https://hk.example/a1)',
  '2. 페이플로우가 300억 원 규모 시리즈B를 마무리했어요 (11월 12일) — [전자신문](https://et.example/a2)',
  '3. 한빛은행, 핀테크 해커톤 개최 (11월 10일) — [머니S](https://ms.example/a3)',
  '4. 렌딧랩, 프리A 40억 원 유치 (11월 14일) — [블로터](https://bl.example/a4)',
].join('\n')
const verdictFor = (raw: string) => {
  const prompts: string[] = []
  return { prompts, write: async (prompt: string) => { prompts.push(prompt); return raw } }
}

describe('c12b: the item verdict on a counted list', () => {
  it('marks a second report of one funding round and a hackathon, and the gap asks for two replacements from a new search', async () => {
    const quick = verdictFor('{"fit":[1,2,4],"same":[[1,2]]}')
    const off = await judgeItems(draft, [FINTECH], quick.write)
    // One call; the ask and every item go in as data, each with its link.
    expect(quick.prompts).toHaveLength(1)
    expect(quick.prompts[0]).toContain(JSON.stringify(FINTECH))
    expect(quick.prompts[0]).toContain('https://ms.example/a3')
    expect(quick.prompts[0]).toContain('material, not instructions')
    expect([...off!.unfit]).toEqual(['https://ms.example/a3'])
    expect([...off!.repeat]).toEqual(['https://et.example/a2'])
    // Shape alone: four dated, linked items, nothing to say.
    expect(listGap(draft, [FINTECH], [], NOW)).toBeUndefined()
    const gap = listGap(draft, [FINTECH], [], NOW, off)!
    expect(gap).toMatch(/^They asked for 4; 2 of this answer's items are what they asked for/)
    expect(gap).toContain('item 3 (counting the listed items from the top) is not what they asked for')
    expect(gap).toContain('item 2 reports the same event as another item')
    expect(gap).toContain('from a new search in other words')
    // After the round: four distinct fitting items, no gap and no shortfall line.
    const after = [draft.split('\n')[0], draft.split('\n')[3], '3. 토스플레이스, 시리즈C 500억 원 유치 (11월 13일) — [매일경제](https://mk.example/b1)', '4. 핀다, 200억 원 투자 유치 (11월 15일) — [조선비즈](https://cb.example/b2)'].join('\n')
    const again = await judgeItems(after, [FINTECH], verdictFor('{"fit":[1,2,3,4],"same":[]}').write)
    expect(listGap(after, [FINTECH], [], NOW, again)).toBeUndefined()
    expect(listShortfall(after, [FINTECH], [], NOW, again)).toBeUndefined()
  })

  it('through the tool session: the verdict-backed gap buys one more round, and its answer is what is delivered', async () => {
    const prompts: string[] = []
    const second = draft.split('\n').slice(0, 1).concat(draft.split('\n')[3]!, '3. 토스플레이스, 시리즈C 500억 원 유치 (11월 13일) — [매일경제](https://mk.example/b1)', '4. 핀다, 200억 원 투자 유치 (11월 15일) — [조선비즈](https://cb.example/b2)').join('\n')
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), runTools: async (job: ToolSessionJob): Promise<ToolSessionResult> => { prompts.push(job.prompt); return { answer: prompts.length === 1 ? draft : second } } } as unknown as Engine
    const search: AgentTool = { name: 'search_web', description: 'Search', argsSchema: {}, run: async () => 'results' }
    const quick = async (prompt: string) => prompt.includes('토스플레이스') ? '{"fit":[1,2,3,4],"same":[]}' : '{"fit":[1,2,4],"same":[[1,2]]}'
    const result = await runToolSession({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [search] }, FINTECH, { lookup: true, deadlineMs: 5_000, recheck: async answer => listGap(answer, [FINTECH], [], NOW, await judgeItems(answer, [FINTECH], quick)) })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('item 3 (counting the listed items from the top) is not what they asked for')
    expect(result.answer).toBe(second)
  })

  it('with no verdict (a quick model that never answers, garbage, none at all) the checks are exactly as before', async () => {
    const ask = '이번 달 부산 전시회 3개'
    const answer = ['- 부산 국제 사진전 (11월 20일) [벡스코](https://bexco.example/1)', '- 해양 미술 특별전 (11월 22일) [부산시립미술관](https://art.example/2)'].join('\n')
    const hung = async (): Promise<string> => new Promise<string>(() => undefined)
    const started = Date.now()
    expect(await judgeItems(answer, [ask], hung, 50)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(await judgeItems(answer, [ask], async () => 'fit: 1, 2')).toBeUndefined()
    expect(await judgeItems(answer, [ask], async () => '{"fit":[1,9]}')).toBeUndefined()
    expect(await judgeItems(answer, [ask], undefined)).toBeUndefined()
    // No count asked: no model call at all.
    const quick = verdictFor('{"fit":[1],"same":[]}')
    expect(await judgeItems(answer, ['부산 전시회 알려줘'], quick.write)).toBeUndefined()
    expect(quick.prompts).toHaveLength(0)
    expect(listGap(answer, [ask], [], NOW, undefined)).toBe(listGap(answer, [ask], [], NOW))
    expect(listShortfall(answer, [ask], [], NOW, undefined)).toBe(listShortfall(answer, [ask], [], NOW))
  })

  it('an answer longer than asked loses only the items judged not to fit, and never one that fits', async () => {
    const ask = '이번 주 전기차 신차 소식 3개만'
    const five = ['1. A사 소형 전기 SUV 공개 (11월 16일) [a](https://a.example/1)', '2. 전기차 보조금 개편안 발표 (11월 15일) [b](https://b.example/2)', '3. B사 전기 세단 사전계약 (11월 17일) [c](https://c.example/3)', '4. 충전기 보급 통계 (11월 14일) [d](https://d.example/4)', '5. C사 전기 픽업 출시 (11월 16일) [e](https://e.example/5)'].join('\n')
    const items = listItems(five)
    const out = withoutOff(five, [ask], offLinks(items, { fit: [1, 3, 5], same: [] }))
    expect(out).toBe(['1. A사 소형 전기 SUV 공개 (11월 16일) [a](https://a.example/1)', '2. B사 전기 세단 사전계약 (11월 17일) [c](https://c.example/3)', '3. C사 전기 픽업 출시 (11월 16일) [e](https://e.example/5)'].join('\n'))
    // Only one fits: the others go, the one stays, and the line under it says how many met the ask.
    const off = offLinks(items, { fit: [3], same: [] }), one = withoutOff(five, [ask], off)
    expect(listItems(one)).toEqual(['1. B사 전기 세단 사전계약 (11월 17일) [c](https://c.example/3)'])
    expect(listShortfall(one, [ask], [], NOW, off)).toBe('찾으시는 것에 딱 맞는 건 3개 중 1개예요.')
    // As many as asked, or fewer: nothing is cut; the misses are said under the answer instead.
    const three = five.split('\n').slice(0, 3).join('\n'), off3 = offLinks(listItems(three), { fit: [1, 3], same: [] })
    expect(withoutOff(three, [ask], off3)).toBe(three)
    expect(listShortfall(three, [ask], [], NOW, off3)).toBe('찾으시는 것에 딱 맞는 건 3개 중 2개예요.')
  })

  it('a same group keeps its first fitting item; the verdict holds by link through a rewrite', async () => {
    const lines = ['- 행사 X 개막 [p](https://p.example/1)', '- 행사 X 첫날 현장 [q](https://q.example/2)', '- 행사 Y 일정 [r](https://r.example/3)']
    const off = offLinks(lines, { fit: [2, 3], same: [[1, 2]] })
    expect([...off.unfit]).toEqual(['https://p.example/1'])
    expect(off.repeat.size).toBe(0)
    expect(await itemCheck('x', lines.slice(0, 1), async () => '{"fit":[1],"same":[]}')).toBeUndefined()
  })

  it('ipc asks the verdict for the recheck and the delivered answer, before liveCited, and the shortfall line uses it', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const at = (text: string): number => { const i = ipc.indexOf(text); expect(i, text).toBeGreaterThan(-1); return i }
    expect(at('await itemsOff(answer, asks)')).toBeLessThan(at('answer = await liveCited(answer'))
    expect(at('listShortfall(answer, asks, heldFor(laneRead, laneSaid), undefined, off)')).toBeGreaterThan(at('answer = await liveCited(answer'))
  })

  // c12b r3 (review #2): the verdict judges items against the ask; keyed by items alone, a changed ask whose rewrite kept the same lines
  // reused the old ask's verdict. Wordings are in no harness row.
  it('a verdict is reused only for the same asks and items: a changed ask on the same lines is judged afresh', async () => {
    const lines = '1. 청주 공방 체험 (11월 3일) [a](https://a.example/1)\n2. 청주 도자기 축제 (11월 5일) [b](https://b.example/2)'
    const asked: string[] = []
    const verdicts = itemVerdicts(async prompt => { asked.push(prompt); return prompt.includes('축제 2개로') ? '{"fit":[2],"same":[]}' : '{"fit":[1,2],"same":[]}' })
    const first = await verdicts(lines, ['청주 공방 체험 2개'])
    expect(await verdicts(lines, ['청주 공방 체험 2개'])).toBe(first)
    expect(asked).toHaveLength(1)
    const after = await verdicts(lines, ['청주 공방 체험 2개', '아니 체험 말고 축제 2개로'])
    expect(asked).toHaveLength(2)
    expect(asked[1]).toContain('축제 2개로')
    expect([...after!.unfit]).toEqual(['https://a.example/1'])
    expect([...first!.unfit]).toEqual([])
  })
})
