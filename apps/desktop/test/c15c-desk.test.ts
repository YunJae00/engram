import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { readFileSync } from 'node:fs'
import * as deskLane from '../src/main/desk-lane.js'
const DESK_FUNCTIONS = ['askNow', 'closingBuilds', 'deskKind', 'deskLane', 'deskLight', 'fileGiven', 'fixSlideTitle', 'isCorrection', 'keptFix', 'kindSortAsk', 'namedText', 'onlyTells', 'plainKeep', 'routeAsk', 'slideTitleFix', 'sortByKind']
const functionsOf = (module: object): string[] => Object.entries(module).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const answerSetInTurn = (ipc: string): number => ipc.slice(ipc.indexOf('await answer({'), ipc.indexOf('answerDelivered = true')).split('result.answer = ').length - 1
import { runToolSession, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
import { MEMORY_YIELDS, turnRunning, yielding } from '../src/main/comet-memory.js'

const SOURCE = '# 무선 이어폰 리뷰\n\n## 써 본 느낌\n- 무게가 4g이라 오래 껴도 귀가 안 아프다.\n- 배터리가 5시간밖에 안 간다.\n- 노이즈 캔슬링이 지하철에서도 잘 된다.\n'
const ASK = '리뷰 메모 장점이랑 단점으로 나눠서 정리해줘'
const DRAFT = '장점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요\n\n단점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요'
const FIXED = '장점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요\n\n단점\n\n- 배터리가 5시간밖에 안 가요'

const ONCE = 'A decision or item is listed once, never again under a second heading.'
const ONLY_FILE = 'holds only what is in it: add no item, number, owner, date or open question that is not there'
async function deskTurn(draft: string, said = ASK, source = SOURCE) {
  const jobs: ToolSessionJob[] = []
  const quick = vi.fn(async () => '{"problems":[]}')
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: 'x' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: draft } }, quick } as unknown as Engine
  const result = await runToolSession({ engine, workdir: '/tmp/c15c-desk' as EngineCwd, tools: [] }, said, { attachmentContext: [deskLane.DESK_NOTE, deskLane.fileGiven({ name: 'memo.md', text: source })].join('\n\n') })
  return { posted: result.answer, calls: jobs.length, quick, told: jobs.map(job => `${job.system}\n${job.prompt}`).join('\n') }
}
const times = (text: string, line: string): number => text.split('\n').filter(one => one.includes(line)).length

describe('a structured desk answer is the model\'s own, posted as written (D1 class)', () => {
  it('posts every shape byte for byte: a list, numbers, a table, one sentence, label rows', async () => {
    for (const shape of [DRAFT, '1. 하나\n2. 둘', '| 항목 | 값 |\n| 가 | 1 |', '평년 기준으로 31,536,000초예요.', '칼국수 어때요? 쌀쌀하니까요.', '장점: 가벼워요.\n\n단점: 배터리가 짧아요.', '원인: 캐시가 오래됐어요.\n대책: 매일 비워요.']) expect((await deskTurn(shape)).posted, shape).toBe(shape)
  })
  it('parts that say the same thing are the model\'s to avoid: it is told once is enough, has the source, and what it writes is posted in one call', async () => {
    const { posted, told, calls, quick } = await deskTurn(FIXED)
    expect(told).toContain(ONCE)
    expect(told).toContain('배터리가 5시간밖에')
    expect(posted).toBe(FIXED)
    expect(calls).toBe(1)
    expect(quick).not.toHaveBeenCalled()
    expect((await deskTurn(DRAFT)).posted).toBe(DRAFT)
  })
  it('a one-line answer is never held: no call at all', async () => {
    const { posted, quick } = await deskTurn('배터리만 빼면 만족스러운 이어폰이에요.', '이 메모 한 줄로 요약해줘')
    expect(posted).toBe('배터리만 빼면 만족스러운 이어폰이에요.')
    expect(quick).not.toHaveBeenCalled()
  })
  it('the draft stands unchecked whatever the turn\'s time: the chat turn has no desk check to run', async () => {
    const { posted, quick } = await deskTurn(DRAFT)
    expect(posted).toBe(DRAFT)
    expect(quick).not.toHaveBeenCalled()
    const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    expect(answerSetInTurn(ipc)).toBe(1)
    expect(ipc).toContain('`${result.asked ? askText(result.answer, result.options) : result.answer}${note}`,')
  })
  it('two short sections go out as written too (r2)', async () => {
    const two = '장점: 가벼워요.\n\n단점: 가벼워요.'
    const { posted, calls, quick } = await deskTurn(two)
    expect(posted).toBe(two)
    expect(calls).toBe(1)
    expect(quick).not.toHaveBeenCalled()
  })
  it('the host takes no line out of an answer: a line said under two parts is posted under both (r2)', async () => {
    const STILL = '장점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요\n\n단점\n\n- 배터리가 5시간밖에 안 가요\n- 노이즈 캔슬링이 좋아요'
    const { posted } = await deskTurn(STILL)
    expect(posted).toBe(STILL)
    expect(times(posted, '노이즈 캔슬링이 좋아요')).toBe(2)
  })
  it('a list with a line the file does not say is posted whole; the rule against it is in the prompt, not after the answer (r2; stack-15)', async () => {
    const draft = '좋은 점\n- 귀가 안 아파요\n- 배터리가 하루 종일 가요\n\n아쉬운 점\n- 없어요'
    const { posted, told } = await deskTurn(draft, '이어폰 리뷰 좋은 점 아쉬운 점으로')
    expect(told).toContain(ONLY_FILE)
    expect(posted).toBe(draft)
  })
})

describe('a copy under a second part', () => {
  it('is gone with the check that fed it: a copy under a second part and a heading are posted as the model wrote them', async () => {
    const text = '원인\n- 캐시가 오래됐어요\n\n대책\n- 캐시가 오래됐어요\n\n메모\n서버는 정상이에요'
    expect(functionsOf(deskLane)).toEqual(DESK_FUNCTIONS)
    expect((await deskTurn(text)).posted).toBe(text)
    expect(Object.keys(deskLane)).toContain('DESK_NOTE')
  })
})

describe('background memory calls yield to a person\'s starting turn (D3, C5 class)', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  it('a call queued while a turn starts waits until the turn has its first token', async () => {
    const started = vi.fn()
    const done = turnRunning()
    const call = yielding(async () => { started(); return 'kept' })
    await tick()
    expect(started).not.toHaveBeenCalled()
    done()
    expect(await call).toBe('kept')
    expect(started).toHaveBeenCalledTimes(1)
  })
  it('a call under way is cut when a turn starts, and runs again after it; the turn never waits on it', async () => {
    let runs = 0
    const call = yielding(signal => new Promise<string>((resolve, reject) => {
      runs++
      if (runs > 1) return resolve('second')
      signal.addEventListener('abort', () => reject(new Error('cut')))
    }))
    await tick()
    expect(runs).toBe(1)
    const done = turnRunning()
    await tick()
    expect(runs).toBe(1)
    done()
    expect(await call).toBe('second')
  })
  it('is dropped, not kept waiting forever, when turns keep starting', async () => {
    let runs = 0
    const call = yielding(signal => new Promise<string>((_resolve, reject) => { runs++; signal.addEventListener('abort', () => reject(new Error('cut'))) }))
    for (let i = 0; i < MEMORY_YIELDS; i++) { await tick(); turnRunning()() }
    expect(await call).toBeUndefined()
    expect(runs).toBe(MEMORY_YIELDS)
  })
  it('the person\'s stop ends it at once', async () => {
    const stop = new AbortController()
    const call = yielding(signal => new Promise<string>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped'))) }), stop.signal)
    await tick()
    stop.abort()
    await expect(call).rejects.toThrow('stopped')
  })
})

describe('the host never drops a copy and never writes a line of its own (r3)', () => {
  const RETRO = '합의한 것\n- 배포는 금요일에 하기로 했어요\n- 코드 리뷰는 둘이 봐요\n\n각자 할 일\n- 배포는 금요일에 하기로 했어요\n- 민지: 리뷰 규칙 문서 쓰기'
  it('an item repeated in two parts stays under both; saying it once is asked of the model', async () => {
    const { posted, told } = await deskTurn(RETRO)
    expect(posted).toBe(RETRO)
    expect(told).toContain(ONCE)
    expect(told).toContain('Each thing goes under one of them, never both')
  })
  it('no copy is removed: the host does not judge which one is wrong', async () => {
    const { posted, quick } = await deskTurn(RETRO)
    expect(times(posted, '배포는 금요일에 하기로 했어요')).toBe(2)
    expect(quick).not.toHaveBeenCalled()
  })
  it('never a host line in place of the answer: the words posted are the model\'s, every one', async () => {
    const draft = '좋은 점\n- 배터리가 오래 가요\n\n아쉬운 점\n- 무거워요'
    const { posted } = await deskTurn(draft, '이어폰 메모 좋은 점 아쉬운 점으로 나눠줘')
    expect(posted.trim()).not.toBe('')
    expect(posted.split('\n')).toEqual(draft.split('\n'))
  })
  it('a draft with a blank line inside a list keeps it: no line and no gap is taken out', async () => {
    const draft = '좋은 점\n- 귀가 안 아파요\n\n- 배터리가 오래 가요\n\n아쉬운 점\n- 없어요'
    expect((await deskTurn(draft, '이어폰 메모 좋은 점 아쉬운 점으로 나눠줘')).posted).toBe(draft)
  })
})

describe('a list goes out whole, every row as written (H2 class, rule 7)', () => {
  const DRAFT = '10월 방문자는 모두 9,200명이에요.\n\n지점별 방문자:\n\n강남점: 4,100명\n홍대점: 3,000명\n잠실점: 2,100명\n\n요일별 방문자:\n\n토요일: 4,100명\n일요일: 3,000명'
  it('label: value rows, their headings and the answer line all stay', async () => {
    const { posted } = await deskTurn(DRAFT, '방문자 csv에서 10월 방문자 수 알려줘', '지점,요일,방문자')
    expect(posted).toBe(DRAFT)
    for (const row of ['강남점: 4,100명', '홍대점: 3,000명', '잠실점: 2,100명', '토요일: 4,100명', '일요일: 3,000명']) expect(posted).toContain(row)
  })
  it('a one-fact ask from a file is asked to be one sentence in the rules; a longer answer is still posted whole', async () => {
    const { posted, told } = await deskTurn(DRAFT, '방문자 csv에서 10월 방문자 수 알려줘', '지점,요일,방문자')
    expect(told).toContain('A question about a file they named is answered with what they asked and nothing else: a figure in one sentence with the number.')
    expect(told).toContain('gets that fact in one sentence, also when it comes from a file')
    expect(posted).toContain('강남점')
    expect(posted.split('\n')).toHaveLength(DRAFT.split('\n').length)
  })
  it('no host line that asks the person for anything is added (c15c r3 #2)', async () => {
    const draft = '좋은 점\n- 가벼워요\n\n아쉬운 점\n- 무거워요'
    const { posted } = await deskTurn(draft, '이어폰 메모 좋은 점 아쉬운 점으로 나눠줘')
    expect(posted).toBe(draft)
    expect(posted).not.toMatch(/말씀해|다시|\?/)
  })
})
