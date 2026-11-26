import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import type { Engine } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/prompt.js'
import { answer, openWorld } from '../src/main/answer.js'

const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
const posted = async (draft: string): Promise<string | undefined> => {
  const dir = await mkdtemp(join(tmpdir(), 'c10a-weather-'))
  try {
    const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), runTools: async () => ({ answer: draft }) } as unknown as Engine
    return (await answer(await openWorld(dir, engine), '여수 토요일 일요일 바람 많이 불어?', { tools: [], ack: { interactive: false } })).result?.answer
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('c10a L1: a weather answer is posted with its ".0" and its bracketed date as written; whole degrees and plain dates are rules the model reads', async () => {
  for (const kept of ['오늘(12월 3일)은 흐리고 지금 7.0도예요. [기상청](https://www.weather.go.kr/w/index.do)', '내일(4일 목)은 -1.0℃, 모레(12월 5일)는 6.0°까지 올라요.', '지금 8.5도예요.', '1엔에 9.0원이에요.']) expect(await posted(kept)).toBe(kept)
  expect(existsSync(new URL('../src/main/fast-lane.ts', import.meta.url))).toBe(false)
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('answerDelivered = true')).match(/result\.answer = \w+/g)).toEqual(['result.answer = answered'])
  expect(COLLEAGUE_CORE_RULE).toContain('a whole number has no ".0", and a day is said with its date in plain words, never in brackets')
})

test('c10a r2: a weekend answer is never rewritten, lumped or day by day', async () => {
  for (const draft of ['토요일이랑 일요일 다 바람이 세요.', '토·일 모두 초속 8미터 안팎이에요.', '토요일은 잔잔하고 일요일 오후에 바람이 세져요.', '| 토요일 | 초속 3m |\n| 일요일 | 초속 9m |', '6일(토)은 잔잔하고 7일(일)은 세요.'])
    expect(await posted(draft), draft).toBe(draft)
})
