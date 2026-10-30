import { expect, it } from 'vitest'
import { recordPlaybook } from 'core'
import { done, setup } from './task-runner-fixture.js'

it('starts scheduled work from a saved route and explicitly waits for expired login', async () => {
  const t = await setup(async () => done('Observed'))
  await recordPlaybook(t.paths, 'Read the daily report', [
    { tool: 'open_page', args: { url: 'https://work.example/report' }, observation: 'Report page' },
    { tool: 'read_open_page', args: {}, observation: 'Report' },
    { tool: 'look', args: {}, observation: 'Confirmed' },
  ])
  await t.runner.chat({ botId: 'bot-1', engineId: '', message: 'Read the daily report', history: [], scheduled: true })
  expect(t.sent[0]?.extra?.context).toContain('https://work.example/report')
  expect(t.sent[0]?.extra?.context).toContain('Do not rediscover')
  expect(t.sent[0]?.extra?.context).toContain('stop in waiting')
})
