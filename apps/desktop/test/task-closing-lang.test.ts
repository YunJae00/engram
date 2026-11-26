import { expect, it } from 'vitest'
import { appendBotTurn, createTask, readBotTranscript, updateTask, type DelegatedTask } from 'core'
import type { EngramEvent } from 'core'
import { setup } from './task-runner-fixture.js'
import { closeTask } from '../src/main/task-closing.js'

const said = (events: EngramEvent[]) => events.flatMap(e => e.type === 'chat:error' ? [e.message] : e.type === 'chat:done' ? [e.text] : [])

it('an error before the task exists gets the usage line in the language of the last thing the person said, stored once', async () => {
  for (const [said_, line] of [['재고 엑셀 합쳐줘', /^AI 사용 한도에 도달했어요/], ['Merge the stock sheets', /^AI usage limit reached/]] as const) {
    const t = await setup(async () => undefined)
    await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: said_, at: new Date().toISOString() })
    const events: EngramEvent[] = []
    await closeTask(t.paths, e => events.push(e), { channel: 'bot-bot-1', goal: said_, error: new Error('socket hang up') })
    expect(said(events)).toEqual([expect.stringMatching(line)])
    expect((await readBotTranscript(t.paths, 'bot-1')).filter(turn => turn.role === 'assistant').map(turn => turn.text)).toEqual(said(events))
  }
})

it('a failed task with no error gets the usage line in the language of the last thing the person said', async () => {
  const t = await setup(async () => undefined)
  const task = await createTask(t.paths, 'Match the delivery dates', 'bot-1')
  const failed = await updateTask(t.paths, task.id, x => { x.state = 'failed' }) as DelegatedTask
  await appendBotTurn(t.paths, 'bot-1', { role: 'user', text: '납품 날짜 맞춰줘', at: new Date().toISOString() })
  const events: EngramEvent[] = []
  await closeTask(t.paths, e => events.push(e), { task: failed, channel: 'bot-bot-1' })
  expect(said(events)).toEqual([expect.stringMatching(/^AI 사용 한도에 도달했어요/)])
  const running: EngramEvent[] = []
  await closeTask(t.paths, e => running.push(e), { task: { ...failed, state: 'running' }, channel: 'bot-bot-1' })
  expect(running).toEqual([])
})
