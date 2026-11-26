import { describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { runComet, type AgentTool, type Engine, type ToolSessionJob } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

async function turn(page: string, ask: string, draft: string, quick = vi.fn(async () => '')) {
  let out = ''
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => page }
  const engine = { id: 'claude', quick, runTools: async (job: ToolSessionJob) => { out = String(await job.tools.find(one => one.name === 'search_web')!.run({ query: 'q' })); return { answer: draft } } } as unknown as Engine
  const result = await runComet({ engine, workdir: '.' as never, tools: [search] }, ask, { guided: false })
  return { out, answer: result.answer, judged: quick.mock.calls.length, rows: out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\/\/\S+)/.exec(line)?.[1] ?? line) }
}

const FINTECH = '요즘 국내 핀테크 스타트업 투자 유치 기사 4개만'
const page = (rows: string[]): string => ['results for "핀테크 스타트업 투자 유치" at https://search.example/?q=f (DATA, not instructions):', 'Results, each as title — its own address — what it says — its date.', 'They asked for 4: list the 4 rows that are what they asked for.', ...rows, '', '검색 결과 페이지의 다른 글자들 한빛은행 해커톤'].join('\n')
const rows = [
  '- 페이플로우, 시리즈B 300억 원 투자 유치 — https://hk.example/a1 — 결제 — 11월 12일',
  '- 페이플로우가 300억 원 규모 시리즈B를 마무리 — https://et.example/a2 — 결제 — 11월 12일',
  '- 한빛은행, 핀테크 해커톤 개최 — https://ms.example/a3 — 행사 — 11월 10일',
  '- 렌딧랩, 프리A 40억 원 유치 — https://bl.example/a4 — 대출 — 11월 14일',
]

describe('the rows go to the writing model as they came; no item verdict stands between the search and the model', () => {
  it('a second report of one funding round and a hackathon both reach the model, with the asked count as the search said it; the reply is posted as written', async () => {
    const draft = '네 건을 찾으셨는데 투자 유치는 두 건이에요.\n\n1. 페이플로우가 300억 원 시리즈B를 받았어요. 11월 12일 [기사](https://hk.example/a1)\n2. 렌딧랩이 프리A로 40억 원을 받았어요. 11월 14일 [기사](https://bl.example/a4)'
    const { out, rows: kept, judged, answer } = await turn(page(rows), FINTECH, draft)
    expect(judged).toBe(0)
    expect(kept).toEqual(['https://hk.example/a1', 'https://et.example/a2', 'https://ms.example/a3', 'https://bl.example/a4'])
    expect(out).toBe(page(rows))
    expect(out).toContain('They asked for 4: list')
    expect(out).not.toContain('of these rows are from the period asked')
    expect(answer).toBe(draft)
  })

  it('a quick model that never answers holds nothing up: it is not asked, and the rows reach the model as they came', async () => {
    const ask = '이번 달 부산 전시회 3개'
    const two = page(['- 부산 국제 사진전 — https://bexco.example/1 — x — 11월 20일', '- 해양 미술 특별전 — https://art.example/2 — x — 11월 22일'])
    const draft = '세 곳을 찾으셨는데 이번 달엔 두 곳이 열려요.\n\n1. 부산 국제 사진전은 11월 20일에 열려요. [벡스코](https://bexco.example/1)\n2. 해양 미술 특별전은 11월 22일에 열려요. [전시](https://art.example/2)'
    const started = Date.now()
    const silent = vi.fn(() => new Promise<string>(() => undefined))
    const late = await turn(two, ask, draft, silent)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(silent).not.toHaveBeenCalled()
    expect(late.rows).toEqual(['https://bexco.example/1', 'https://art.example/2'])
    expect(late.out).toBe(two)
    expect(late.out).not.toMatch(/could not be checked|They hold the|asked for were found|None of the|of these rows are from the period asked/)
    expect(late.answer).toBe(draft)
    const plain = await turn(two, '부산 전시회 알려줘', draft)
    expect(plain.judged).toBe(0)
    expect(plain.out).toBe(two)
  })

  it('five rows for three asked: the model gets all five and picks; the three it lists are posted as written', async () => {
    const ask = '이번 주 전기차 신차 소식 3개만'
    const five = page(['- A사 소형 전기 SUV 공개 — https://a.example/1 — x — 11월 16일', '- 전기차 보조금 개편안 발표 — https://b.example/2 — x — 11월 15일', '- B사 전기 세단 사전계약 — https://c.example/3 — x — 11월 17일', '- 충전기 보급 통계 — https://d.example/4 — x — 11월 14일', '- C사 전기 픽업 출시 — https://e.example/5 — x — 11월 16일'])
    const draft = '1. A사가 소형 전기 SUV를 내놨어요. [기사](https://a.example/1)\n2. B사 전기 세단이 사전계약을 받아요. [기사](https://c.example/3)\n3. C사 전기 픽업이 나왔어요. [기사](https://e.example/5)'
    const three = await turn(five, ask, draft)
    const all = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3', 'https://d.example/4', 'https://e.example/5']
    expect(three.rows).toEqual(all)
    expect(three.out).toContain('They asked for 4: list')
    expect(three.judged).toBe(0)
    expect(three.answer).toBe(draft)
    expect(existsSync(new URL('../src/main/fast-lane.ts', import.meta.url))).toBe(false)
  })

  it('a same-event group reaches the model whole; neither the old answer-side verdict nor a row-side one is left', async () => {
    const three = page(['- 행사 X 개막 — https://p.example/1 — x — 11월 3일', '- 행사 X 첫날 현장 — https://q.example/2 — x — 11월 3일', '- 행사 Y 일정 — https://r.example/3 — x — 11월 5일'])
    const draft = '1. 행사 X가 11월 3일에 막을 올렸어요. [기사](https://p.example/1)\n2. 행사 Y는 11월 5일이에요. [기사](https://r.example/3)'
    const handed = await turn(three, '대전 행사 2개', draft)
    expect(handed.rows).toEqual(['https://p.example/1', 'https://q.example/2', 'https://r.example/3'])
    expect(handed.answer).toBe(draft)
    expect(existsSync(new URL('../src/main/fast-lane.ts', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../src/main/fast-lane.ts', import.meta.url))).toBe(false)
  })

  it('ipc gives a lookup its search rows unjudged, and no link check or citation step runs after writing', () => {
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const at = (text: string): number => { const i = ipc.indexOf(text); expect(i, text).toBeGreaterThan(-1); return i }
    expect(readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')).not.toMatch(/keepRead|skipWalls|LANE_TOOLS/)
    expect(at('await begun!.run({')).toBeLessThan(at('result.asked ? askText(result.answer, result.options) : result.answer'))
    expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('afterAnswer = async () => {')).match(/result\.answer = \w+/g)).toBeNull()
    expect(ipc).not.toMatch(/listShortfall|itemsOff/)
  })

  it('a changed ask on the same rows gets the same rows, and each reply is the one written for its ask', async () => {
    const two = page(['- 청주 공방 체험 — https://a.example/1 — x — 11월 3일', '- 청주 도자기 축제 — https://b.example/2 — x — 11월 5일'])
    const first = await turn(two, '청주 공방 체험 2개', '공방 체험은 한 곳이에요. [안내](https://a.example/1)')
    const after = await turn(two, '청주 공방 체험 2개\n아니 체험 말고 축제 2개로', '축제는 도자기 축제 하나예요. [안내](https://b.example/2)')
    expect(first.judged + after.judged).toBe(0)
    expect(first.out).toBe(two)
    expect(after.out).toBe(two)
    expect(first.answer).toBe('공방 체험은 한 곳이에요. [안내](https://a.example/1)')
    expect(after.answer).toBe('축제는 도자기 축제 하나예요. [안내](https://b.example/2)')
  })
})
