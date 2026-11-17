import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { checkedDesk, structured, withoutQuoted } from '../src/main/desk-lane.js'
import { readProblems } from 'core'
import { MEMORY_YIELDS, turnStarting, yielding } from '../src/main/comet-memory.js'

// c15c (cause D). Wordings are not the harness's: a product review split into 장점/단점.
const SOURCE = '# 무선 이어폰 리뷰\n\n## 써 본 느낌\n- 무게가 4g이라 오래 껴도 귀가 안 아프다.\n- 배터리가 5시간밖에 안 간다.\n- 노이즈 캔슬링이 지하철에서도 잘 된다.\n'
const ASK = '리뷰 메모 장점이랑 단점으로 나눠서 정리해줘'
const DRAFT = '장점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요\n\n단점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요'
const FIXED = '장점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요\n\n단점\n\n- 배터리가 5시간밖에 안 가요'

describe('a structured desk answer is checked against its ask and source (D1 class)', () => {
  it('reads structure by shape, never by words', () => {
    expect(structured(DRAFT)).toBe(true)
    expect(structured('1. 하나\n2. 둘')).toBe(true)
    expect(structured('| 항목 | 값 |\n| 가 | 1 |')).toBe(true)
    expect(structured('평년 기준으로 31,536,000초예요.')).toBe(false)
    expect(structured('칼국수 어때요? 쌀쌀하니까요.')).toBe(false)
    // r2: two short sections are parts, however short.
    expect(structured('장점: 가벼워요.\n\n단점: 배터리가 짧아요.')).toBe(true)
    expect(structured('원인: 캐시가 오래됐어요.\n대책: 매일 비워요.')).toBe(true)
  })
  it('parts that say the same thing are found ("overlap") and the answer is rewritten once from the source', async () => {
    const prompts: string[] = []
    const verdicts = ['{"problems":[{"kind":"overlap","quote":"단점 - 가벼워서 오래 껴도 편해요","why":"장점과 같은 내용"}]}', FIXED, '{"problems":[]}']
    const quick = vi.fn(async (prompt: string) => { prompts.push(prompt); return verdicts.shift() })
    const logged: string[] = []
    const out = await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, quick, since: Date.now(), log: (outcome, kinds) => logged.push(`${outcome}:${kinds.join(',')}`) })
    expect(out).toBe(FIXED)
    expect(quick).toHaveBeenCalledTimes(3)
    expect(prompts[0]).toContain('"overlap"')
    expect(prompts[0]).toContain('배터리가 5시간밖에')
    expect(prompts[1]).toContain('Source:')
    expect(prompts[1]).toContain('overlap')
    expect(logged).toEqual(['rewritten:overlap'])
  })
  it('a one-line answer is never held: no call at all', async () => {
    const quick = vi.fn(async () => '{"problems":[]}')
    expect(await checkedDesk({ ask: '이 메모 한 줄로 요약해줘', draft: '배터리만 빼면 만족스러운 이어폰이에요.', source: SOURCE, quick, since: Date.now() })).toBe('배터리만 빼면 만족스러운 이어폰이에요.')
    expect(quick).not.toHaveBeenCalled()
  })
  it('past the turn\'s budget the draft stands unchecked', async () => {
    const quick = vi.fn(async () => '{"problems":[]}')
    expect(await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, quick, since: Date.now() - 60_000 })).toBe(DRAFT)
    expect(quick).not.toHaveBeenCalled()
  })
  it('two short sections are checked too (r2)', async () => {
    const quick = vi.fn(async () => '{"problems":[]}')
    const two = '장점: 가벼워요.\n\n단점: 가벼워요.'
    await checkedDesk({ ask: ASK, draft: two, source: SOURCE, quick, since: Date.now() })
    expect(quick).toHaveBeenCalledTimes(1)
  })
  it('a rewrite that is still wrong never shows the lines the check named: the last text read, without them (r2)', async () => {
    // The rewrite moved one item but still lists 노이즈 캔슬링 under 단점; its own check quotes that line.
    const STILL = '장점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요\n\n단점\n\n- 배터리가 5시간밖에 안 가요\n- 노이즈 캔슬링이 좋아요'
    const again = ['{"problems":[{"kind":"overlap","quote":"가벼워서 오래 껴도 편해요","why":"두 번"}]}', STILL, '{"problems":[{"kind":"overlap","quote":"단점 - 노이즈 캔슬링이 좋아요","why":"장점과 같음"}]}']
    const logged: string[] = []
    const out = await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, quick: async () => again.shift(), since: Date.now(), log: outcome => logged.push(outcome) })
    expect(logged).toEqual(['refused'])
    expect(out).not.toBe(DRAFT)
    expect(out).toBe('장점\n\n- 가벼워서 오래 껴도 편해요\n- 노이즈 캔슬링이 좋아요\n\n단점\n\n- 배터리가 5시간밖에 안 가요')
  })
  it('a rewrite that came too late leaves the draft without the lines its check named (r2)', async () => {
    const said = ['{"problems":[{"kind":"contradicts","quote":"배터리가 하루 종일 가요","why":"5시간"}]}', undefined]
    const draft = '좋은 점\n- 귀가 안 아파요\n- 배터리가 하루 종일 가요\n\n아쉬운 점\n- 없어요'
    expect(await checkedDesk({ ask: '이어폰 리뷰 좋은 점 아쉬운 점으로', draft, source: SOURCE, quick: async () => said.shift(), since: Date.now() })).toBe('좋은 점\n- 귀가 안 아파요\n\n아쉬운 점\n- 없어요')
  })
})

describe('withoutQuoted', () => {
  it('drops the quoted line, the copy under the part the quote names, and a heading left empty', () => {
    const text = '원인\n- 캐시가 오래됐어요\n\n대책\n- 캐시가 오래됐어요\n\n메모\n서버는 정상이에요'
    expect(withoutQuoted(text, [{ kind: 'overlap', quote: '대책: 캐시가 오래됐어요', why: '' }])).toBe('원인\n- 캐시가 오래됐어요\n\n메모\n서버는 정상이에요')
    expect(withoutQuoted(text, [{ kind: 'contradicts', quote: '서버는 정상이에요', why: '' }])).toBe('원인\n- 캐시가 오래됐어요\n\n대책\n- 캐시가 오래됐어요\n\n메모')
    expect(withoutQuoted(text, [{ kind: 'asks', quote: '', why: '' }])).toBe(text)
  })
})

describe('background memory calls yield to a person\'s starting turn (D3, C5 class)', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 0))
  it('a call queued while a turn starts waits until the turn has its first token', async () => {
    const started = vi.fn()
    const done = turnStarting()
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
    const done = turnStarting()
    await tick()
    expect(runs).toBe(1)
    done()
    expect(await call).toBe('second')
  })
  it('is dropped, not kept waiting forever, when turns keep starting', async () => {
    let runs = 0
    const call = yielding(signal => new Promise<string>((_resolve, reject) => { runs++; signal.addEventListener('abort', () => reject(new Error('cut'))) }))
    for (let i = 0; i < MEMORY_YIELDS; i++) { await tick(); turnStarting()() }
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

// c15c r3. Wordings are not the harness's: a team retro note split into 합의한 것 / 각자 할 일.
describe('the fallback never keeps the wrong copy and never answers empty (r3)', () => {
  const RETRO = '합의한 것\n- 배포는 금요일에 하기로 했어요\n- 코드 리뷰는 둘이 봐요\n\n각자 할 일\n- 배포는 금요일에 하기로 했어요\n- 민지: 리뷰 규칙 문서 쓰기'
  it('a false item repeated in two parts: the copy under the part the quote names goes, the other stays', () => {
    // The check says the decision is false (the source left the day open); the same line under 할 일 is a task and stays.
    expect(withoutQuoted(RETRO, [{ kind: 'contradicts', quote: '합의한 것: 배포는 금요일에 하기로 했어요', why: '요일은 안 정했음' }]))
      .toBe('합의한 것\n- 코드 리뷰는 둘이 봐요\n\n각자 할 일\n- 배포는 금요일에 하기로 했어요\n- 민지: 리뷰 규칙 문서 쓰기')
    // Named the other way round, the other copy goes: position decides nothing.
    expect(withoutQuoted(RETRO, [{ kind: 'overlap', quote: '각자 할 일 - 배포는 금요일에 하기로 했어요', why: '' }]))
      .toBe('합의한 것\n- 배포는 금요일에 하기로 했어요\n- 코드 리뷰는 둘이 봐요\n\n각자 할 일\n- 민지: 리뷰 규칙 문서 쓰기')
  })
  it('a quote that names no part removes every copy: the host cannot tell which one is wrong', () => {
    expect(withoutQuoted(RETRO, [{ kind: 'contradicts', quote: '배포는 금요일에 하기로 했어요', why: '' }]))
      .toBe('합의한 것\n- 코드 리뷰는 둘이 봐요\n\n각자 할 일\n- 민지: 리뷰 규칙 문서 쓰기')
  })
  it('every line quoted and the rewrite failed: never empty, the earlier text read or one plain line', async () => {
    const draft = '좋은 점\n- 배터리가 오래 가요\n\n아쉬운 점\n- 무거워요'
    const all = '{"problems":[{"kind":"contradicts","quote":"배터리가 오래 가요","why":""},{"kind":"contradicts","quote":"무거워요","why":""}]}'
    expect(withoutQuoted(draft, readProblems(all) ?? [])).toBe('')
    const said = [all, undefined]
    const out = await checkedDesk({ ask: '이어폰 메모 좋은 점 아쉬운 점으로 나눠줘', draft, source: SOURCE, quick: async () => said.shift(), since: Date.now() })
    expect(out.trim()).not.toBe('')
    expect(out).toMatch(/[가-힣]/)
    expect(out).not.toContain('배터리가 오래 가요')
    expect(out).not.toContain('무거워요')
  })
  it('the rewrite fully quoted but the draft only partly: the draft without its quoted lines', async () => {
    const draft = '좋은 점\n- 귀가 안 아파요\n- 배터리가 오래 가요\n\n아쉬운 점\n- 없어요'
    const rewrite = '좋은 점\n- 하루 종일 가요'
    const said = ['{"problems":[{"kind":"contradicts","quote":"배터리가 오래 가요","why":""}]}', rewrite, '{"problems":[{"kind":"contradicts","quote":"하루 종일 가요","why":""}]}']
    expect(await checkedDesk({ ask: '이어폰 메모 좋은 점 아쉬운 점으로 나눠줘', draft, source: SOURCE, quick: async () => said.shift(), since: Date.now() }))
      .toBe('좋은 점\n- 귀가 안 아파요\n\n아쉬운 점\n- 없어요')
  })
})
