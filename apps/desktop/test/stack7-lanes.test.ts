import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { CHOICE_RULE, runComet, type Engine } from 'core'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/prompt.js'
import * as firstLine from '../src/main/first-line.js'

const ipc = readFileSync(fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url)), 'utf8')
const posted = async (ask: string, draft: string, options: NonNullable<Parameters<typeof runComet>[2]> = {}): Promise<string> => (await runComet({ engine: { id: 'claude', runTools: async () => ({ answer: draft }) } as unknown as Engine, workdir: '.' as never, tools: [] }, ask, { guided: false, modelHint: 'smart', ...options })).answer

it('stack-7: no desk correction runs on any answer: no desk kind is left, the keep gate runs only outside the team lane, and the turn posts the model\'s words (c11b: asState went)', () => {
  const source = readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')
  expect(source).not.toMatch(/keepAsk|hostable|plainAsk/)
  expect(source).not.toMatch(/deskKind|deskLane|const short =/)
  expect(ipc).toContain('result.asked ? askText(result.answer, result.options) : result.answer,')
  expect(ipc).not.toContain('asState(')
  expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('afterAnswer = async () => {')).match(/result\.answer = \w+/g)).toBeNull()
  expect(existsSync(new URL('../src/main/desk-lane.ts', import.meta.url))).toBe(false)
  expect(Object.keys(firstLine).filter(key => typeof (firstLine as Record<string, unknown>)[key] === 'function').sort()).toEqual(['beginFirstLine', 'cleanLine', 'endFirstLine', 'firstLineCarried', 'firstLineReady', 'firstLineSaw', 'firstLineSpoke', 'firstLineState', 'wantsFirstLine', 'warmFirstLine'])
})

it('stack-7: a team result and a lookup answer reach the thread as written, whatever lane they came through (c11b)', async () => {
  const team = '둘 다 찾아봤어요.\n\n지민: 노션이 AI 회의록을 냈어요. [노션](https://notion.so/a)\n\n서연: 슬랙은 허들 요약을 냈어요. [슬랙](https://slack.com/b)'
  expect(await posted('엔비디아 주식 마감 가격은?', '11월 16일 종가 기준 155.26달러예요.', { lookup: true, maxCalls: 4 })).toBe('11월 16일 종가 기준 155.26달러예요.')
  expect(await posted('노션이랑 슬랙 새로 나온 것 살펴봐', team, { lookup: true, maxCalls: 8 })).toBe(team)
  expect(await posted('노션이랑 슬랙 새로 나온 것 살펴봐', team)).toBe(team)
  expect(COLLEAGUE_CORE_RULE).toContain('A decision or item is listed once, never again under a second heading.')
})

it('stack-7: a share-ready summary has the lead its writer gave it: the host adds none and cuts none, and the lead is asked for in the rules', async () => {
  const ask = 'fixtures/meeting-notes.md 팀에 공유하기 좋게 정리해줘'
  const body = '## 결정사항\n\n- 온보딩 화면은 B안으로 가요.\n\n## 할 일\n\n- 한서연 — 시안 확정, 기한: 11월 20일\n\n## 미결\n\n- 결제 모듈 후보는 다음 회의에서 정해요.'
  const own = '결정사항과 할 일, 미결 위주로 짧게 정리했어요.'
  for (const draft of [`회의록 내용부터 다듬을게요.\n\n${own}\n\n${body}`, `공유용으로 손볼게요.\n\n${body}`, body, `${own}\n\n${body}`]) expect(await posted(ask, draft)).toBe(draft)
  expect(CHOICE_RULE).toContain('decide the way a sensible colleague would and say in a few words what you chose')
  expect(COLLEAGUE_CORE_RULE).toContain('The answer is the first line: no opening line about what you are about to do')
})
