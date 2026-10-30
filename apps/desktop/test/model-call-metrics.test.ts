import { expect, it, vi } from 'vitest'
const log = vi.hoisted(() => vi.fn())
vi.mock('../src/main/flog.js', () => ({ flog: log }))
import { modelCall, withModelCallContext } from '../src/main/model-call-metrics.js'

it('counts task, aside and verification calls without mixing concurrent conversations or logging content', async () => {
  await Promise.all(['one', 'two'].map(channel => withModelCallContext({ channel, task: channel, turn: 1, purpose: 'task' }, async () => {
    await Promise.resolve()
    const call = modelCall('codex', 12000, undefined, 40)
    call.token(); call.token(); call.end()
  })))
  withModelCallContext({ channel: 'one', purpose: 'aside' }, () => modelCall('codex', 500, 'low').end())
  const starts = log.mock.calls.map(([, line]) => JSON.parse(line)).filter(event => event.phase === 'start')
  expect(starts.map(event => [event.channel, event.count, event.purpose])).toEqual([['one', 1, 'task'], ['two', 1, 'task'], ['one', 2, 'aside']])
  expect(starts[0]).toMatchObject({ effort: 'runtime-default', promptChars: 12000, toolCount: 40 })
  expect(log.mock.calls.filter(([, line]) => JSON.parse(line).phase === 'first-token')).toHaveLength(2)
})
