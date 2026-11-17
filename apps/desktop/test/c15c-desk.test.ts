import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { checkedDesk, structured } from '../src/main/desk-lane.js'
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
    expect(structured('정리했어요.\n\n파일은 아래에 있어요.')).toBe(false)
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
  it('past the turn\'s budget, or a rewrite that is still wrong, leaves the draft', async () => {
    const quick = vi.fn(async () => '{"problems":[]}')
    expect(await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, quick, since: Date.now() - 60_000 })).toBe(DRAFT)
    expect(quick).not.toHaveBeenCalled()
    const wrong = '{"problems":[{"kind":"overlap","quote":"x","why":"y"}]}', again = [wrong, FIXED, wrong]
    expect(await checkedDesk({ ask: ASK, draft: DRAFT, source: SOURCE, quick: async () => again.shift(), since: Date.now() })).toBe(DRAFT)
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
