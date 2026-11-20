import { expect, test } from 'vitest'
import { runComet, type AgentTool, type Engine, type ToolSessionJob } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'
import * as lane from '../src/main/fast-lane.js'
import { firstSearch, LANE_NOTE, LANE_SOLO_SOFT_MS, swapRounds, swappedAsk } from '../src/main/fast-lane.js'

const now = new Date('2026-11-17T09:00:00+09:00')
test('c9a T2: a replacement names the new thing in the old one\'s place, with the kind word kept', () => {
  const cases: [string, string, string | undefined][] = [
    ['엔비디아 오늘 주가 알려줘', '그냥 애플로 바꿔', '애플 오늘 주가 알려줘'],
    ['엔비디아 오늘 주가 알려줘', '테슬라 걸로', '테슬라 오늘 주가 알려줘'],
    ['엔비디아 오늘 주가 알려줘', '그냥 삼성전자로 해줘', '삼성전자 오늘 주가 알려줘'],
    ['엔비디아 주가 어때?', '아 엔비디아 말고 애플', '애플 주가 어때?'],
    ['서울 날씨 알려줘', '부산으로 바꿔서 알려줘', '부산 날씨 알려줘'],
    ['이번 주말 서울 날씨 어때?', '대전으로 바꿔줘', '이번 주말 대전 날씨 어때?'],
    ['엔비디아 오늘 주가 알려줘', '표로 바꿔', undefined],
    ['서울 오늘 날씨 알려줘', '내일로 바꿔', undefined],
    ['엔비디아 오늘 주가 알려줘', '아 대구도 추가해', undefined],
    ['엔비디아 오늘 주가 알려줘', '아 왜 이렇게 느려', undefined],
  ]
  for (const [ask, said, want] of cases) expect(swappedAsk(ask, said, now), `${ask} / ${said}`).toBe(want)
})

const hanging = (signal: AbortSignal): Promise<string> => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true }))
test('c9a T2: a replacement said mid-lookup stops the running round and one fresh round runs on the new ask', async () => {
  for (const said of ['그냥 애플로 바꿔', '테슬라 걸로', '그냥 삼성전자로 해줘']) {
    const turn = new AbortController(), lookup = swapRounds('엔비디아 오늘 주가 알려줘', turn.signal)
    const rounds: { ask: string; again: boolean; signal: AbortSignal }[] = []
    const done = lookup.run(async (ask, signal, again) => { rounds.push({ ask, again, signal }); return rounds.length === 1 ? hanging(signal) : `${ask} 답` })
    await Promise.resolve()
    expect(lookup.change(said), said).toBe(true)
    expect(rounds[0]!.signal.aborted).toBe(true)
    const answer = await done
    expect(rounds).toHaveLength(2)
    expect(rounds[1]!.again).toBe(true)
    expect(rounds[1]!.ask).not.toContain('엔비디아')
    expect(rounds[1]!.ask).toContain('주가')
    expect(answer).toBe(`${rounds[1]!.ask} 답`)
    expect(turn.signal.aborted).toBe(false)
  }
})
test('c9a T2: an addition, a remark or a form change does not stop the round', async () => {
  for (const said of ['아 대구도 추가해', '아 왜 이렇게 느려', '표로 바꿔']) {
    const lookup = swapRounds('엔비디아 오늘 주가 알려줘', new AbortController().signal)
    const signal = lookup.signal()
    expect(lookup.change(said), said).toBe(false)
    expect(signal.aborted).toBe(false)
  }
})
test('c9a T2: a change said during the host first search starts the first round on the new ask', async () => {
  const lookup = swapRounds('엔비디아 오늘 주가 알려줘', new AbortController().signal)
  lookup.change('그냥 애플로 바꿔')
  const seen: [string, boolean][] = []
  await lookup.run(async (ask, _signal, again) => { seen.push([ask, again]); return '' })
  expect(seen).toEqual([['애플 오늘 주가 알려줘', true]])
  expect(lookup.ask()).toBe('애플 오늘 주가 알려줘')
})
test('c9a T2: a stop of the whole turn still ends it', async () => {
  const turn = new AbortController(), lookup = swapRounds('엔비디아 오늘 주가 알려줘', turn.signal)
  const done = lookup.run(async (_ask, signal) => hanging(signal))
  turn.abort()
  await expect(done).rejects.toThrow('canceled')
})
test('c9a T2: the lookup answer names its subject first', () => {
  expect(LANE_NOTE).toContain('That first sentence opens on what the figure is about, by the name the person used ("애플은 어제 종가 기준 …"')
})

test('c10a T2: after a swap the new round is told to name the new subject first, and the sentence it writes is posted as written, named or not', async () => {
  const ask = swappedAsk('테슬라 주가 어때?', '아 테슬라 말고 애플', now)!
  expect(ask).toBe('애플 주가 어때?')
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.naver.com/search.naver?query=애플+주가 (DATA, not instructions):\n애플 AAPL 352.78 USD` }
  const first = await firstSearch(ask, search, undefined, now)
  expect(first.opening).toContain('If the person changes what they ask for while you work, these results are for the old ask: search for the new one, and name what the answer is now about in its first sentence ("애플은 …").')
  for (const draft of ['미국 장이 아직 개장 전이라 전일 종가 기준 352.78달러예요. [네이버 증권](https://search.naver.com/search.naver?query=애플+주가)', '애플은 미국 장이 아직 개장 전이라 전일 종가 기준 352.78달러예요.', 'AAPL은 어제 종가 기준 352.78달러예요.']) {
    let told = ''
    const engine = { id: 'claude', runTools: async (job: ToolSessionJob) => { told = `${job.system}\n${job.prompt}`; return { answer: draft } } } as unknown as Engine
    const result = await runComet({ engine, workdir: '.' as never, tools: [search] }, ask, { guided: false, modelHint: 'smart', lookup: true, maxCalls: first.calls, deadlineMs: LANE_SOLO_SOFT_MS, attachmentContext: [LANE_NOTE, first.opening].join('\n\n') })
    expect(result.answer).toBe(draft)
    expect(told).toContain('always, and above all after they changed what they asked for')
    expect(told).toContain('name what the answer is now about in its first sentence')
  }
  expect('namesSubject' in lane).toBe(false)
  expect(COLLEAGUE_CORE_RULE).toContain('When they change the ask while you work, the first sentence names the new subject.')
})
