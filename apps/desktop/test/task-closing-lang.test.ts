import { expect, it } from 'vitest'
import { appendBotTurn } from 'core'
import type { EngramEvent } from 'core'
import { setup } from './task-runner-fixture.js'
import { closeTask } from '../src/main/task-closing.js'

it('an error before the task exists closes in the language of the request that failed', async () => {
  const t = await setup(async () => undefined)
  await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: 'Summarize this', at: new Date().toISOString() })
  const events: EngramEvent[] = []
  await closeTask(t.paths, e => events.push(e), { reason: 'error', channel: 'bot-bot-1', goal: '정리해줘', error: new Error('boom') })
  const said = events.find(e => e.type === 'chat:error')
  expect(said && 'message' in said ? said.message : '').not.toMatch(/Done so far|Next:/)
})
