import { expect, it } from 'vitest'
import { done, setup } from './task-runner-fixture.js'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { appendBotTurn, initVault, readBotTranscript } from 'core'

const ASK = '거래처에 보낼 사과 문구를 격식 있게 두 문장으로 써줘'

it('the answer is posted on the turn of its own ask, and every continuation turn carries the task\'s ask', async () => {
  const report = '납품이 늦어진 점 깊이 사과드립니다. 다음 주 월요일까지 반드시 보내 드리겠습니다.'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } }
    : { ...done(report, 1), check: { accepted: true, issues: [], reportUnchanged: true }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat(ASK)
  expect(t.sent).toHaveLength(2)
  expect(t.sent[1]?.extra?.asked).toBe(ASK)
  expect(t.sent[0]?.request.message).toBe(ASK)
  expect(t.delivered).toEqual([report])
  expect(t.deliveredAsked).toEqual([undefined])
})

it('the ask of a reply posted after an unrelated exchange is its own ask, kept on that turn, not the message before it', async () => {
  const history = [
    { role: 'user', text: ASK }, { role: 'assistant', text: '격식 있게 써서 올릴게요.' },
    { role: 'user', text: '오늘 며칠이야?' }, { role: 'assistant', text: '11월 18일이에요.' },
    { role: 'assistant', text: '납품이 늦어진 점 깊이 사과드립니다. 다음 주 월요일까지 보내 드리겠습니다.', asked: ASK },
  ]
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/c14b-asked-'))
  try {
    const paths = await initVault(root, { git: false })
    for (const [at, turn] of history.entries()) await appendBotTurn(paths, '1', { ...turn, role: turn.role as 'user' | 'assistant', at: new Date(Date.UTC(2026, 10, 18, 9, at)).toISOString() })
    const kept = await readBotTranscript(paths, '1')
    expect(kept.map(turn => turn.text)).toEqual(history.map(turn => turn.text))
    expect(kept.at(-1)?.asked).toBe(ASK)
    expect(kept.slice(0, 4).map(turn => turn.asked)).toEqual([undefined, undefined, undefined, undefined])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('the app keeps the ask on the transcript turn of a delivered or a task turn\'s answer', async () => {
  const { readFileSync } = await import('node:fs'), { resolve } = await import('node:path')
  const ipc = readFileSync(resolve(__dirname, '../src/main/ipc.ts'), 'utf8')
  expect(ipc).toContain('deliver: async (channel, text, since, trail, evidence, asked) => {')
  expect(ipc).toContain('...(asked ? { asked: withoutSecrets(asked, asked) } : {}) })')
  expect(ipc).toContain('...(turn?.asked ? { asked: withoutSecrets(turn.asked, turn.asked) } : {}), ...(files.length ? { files: [...files] } : {}) }).catch(() => undefined)')
})
