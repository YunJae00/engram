import { expect, it } from 'vitest'
import { done, setup } from './task-runner-fixture.js'
import { askedBefore } from '../src/main/desk-lane.js'

// c14b r2 (Codex r1 #3): a task's answer posted later, after an unrelated question and its answer, answers the task's ask, not the message
// just before it. The runner hands that ask to every continuation turn and to every delivery, and the transcript turn keeps it (`asked`),
// so the reshape voice ("더 짧게") keeps the constraints of the ask the reply really answered. Wordings are not the harness's.
const ASK = '거래처에 보낼 사과 문구를 격식 있게 두 문장으로 써줘'

it('every continuation turn and every delivery of a task carries the task\'s ask', async () => {
  const report = '납품이 늦어진 점 깊이 사과드립니다. 다음 주 월요일까지 반드시 보내 드리겠습니다.'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } }
    : { ...done(report, 1), check: { accepted: true, issues: [], reportUnchanged: true }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat(ASK)
  expect(t.sent).toHaveLength(2)
  expect(t.sent[1]?.extra?.asked).toBe(ASK)
  expect(t.delivered).toEqual([report])
  expect(t.deliveredAsked).toEqual([ASK])
})

it('the ask of a reply posted after an unrelated exchange is its own ask, not the message before it', () => {
  const history = [
    { role: 'user', text: ASK }, { role: 'assistant', text: '격식 있게 써서 올릴게요.' },
    { role: 'user', text: '오늘 며칠이야?' }, { role: 'assistant', text: '11월 18일이에요.' },
    { role: 'assistant', text: '납품이 늦어진 점 깊이 사과드립니다. 다음 주 월요일까지 보내 드리겠습니다.', asked: ASK },
  ]
  expect(askedBefore(history)).toBe(ASK)
  // A reply with no ask of its own answers the person's message before it, as before.
  expect(askedBefore(history.slice(0, 4))).toBe('오늘 며칠이야?')
})

it('the app keeps the ask on the transcript turn of a delivered or a task turn\'s answer', async () => {
  const { readFileSync } = await import('node:fs'), { resolve } = await import('node:path')
  const ipc = readFileSync(resolve(__dirname, '../src/main/ipc.ts'), 'utf8')
  expect(ipc).toContain('deliver: async (channel, text, since, trail, evidence, asked) => {')
  expect(ipc).toContain('...(asked ? { asked: withoutSecrets(asked, asked) } : {}) })')
  expect(ipc).toContain('...(turn?.asked ? { asked: withoutSecrets(turn.asked, turn.asked) } : {}) }).catch(() => undefined)')
})
