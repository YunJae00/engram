import { expect, test } from 'vitest'
import { LANE_NOTE, swapRounds, swappedAsk } from '../src/main/fast-lane.js'

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

// A round that runs until it is stopped, like a model call on the old ask.
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
