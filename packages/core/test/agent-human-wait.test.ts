import { expect, it, vi } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runToolSession } from '../src/agent-session.js'
import { formatAsk } from '../src/ask.js'
import { pageTools } from '../src/comet-page-tools.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'

const workdir = 'tmp/harness-wait' as EngineCwd
const tool = (name: string, observation = 'Visible result'): AgentTool => ({ name, description: name, argsSchema: {}, run: async () => observation })
const engine = (runTools: Engine['runTools']): Engine => ({ id: 'mock', desktopToolIsolation: true, runTools } as Engine)

it.each(['read_open_page', 'read_pages', 'look'])('finishes %s without a receipt or another model turn', async name => {
  const run = vi.fn(async (job: ToolSessionJob) => {
    await job.tools.find(t => t.name === name)!.run({})
    return { answer: 'The value is 42.' }
  })
  const result = await runToolSession({ engine: engine(run), workdir, tools: [tool('open_page'), tool(name, '42')] }, 'What is the value?')
  expect(run).toHaveBeenCalledOnce()
  expect(result.answer).toBe('The value is 42.')
  expect(result.incomplete).toBeUndefined()
})

it('keeps the streamed answer when a retry only records its receipt', async () => {
  let turns = 0
  const reset = vi.fn(), token = vi.fn()
  const run = vi.fn(async (job: ToolSessionJob) => {
    if (++turns === 1) {
      await job.tools.find(t => t.name === 'page_steps')!.run({ steps: [{ do: 'press', target: 'Save' }] })
      job.onToken?.('The requested result is saved.')
      return { answer: 'The requested result is saved.' }
    }
    await job.tools.find(t => t.name === 'collect_results')!.run({ status: 'complete', summary: 'Saved', evidenceStep: 1 })
    job.onToken?.('Receipt recorded.')
    return { answer: 'Receipt recorded.' }
  })
  const result = await runToolSession({ engine: engine(run), workdir, tools: [tool('open_page'), tool('page_steps')] }, 'Save the result', { onReset: reset, onToken: token })
  expect(run).toHaveBeenCalledTimes(2)
  expect(reset).not.toHaveBeenCalled()
  expect(token.mock.calls).toEqual([['The requested result is saved.']])
  expect(result.answer).toBe('The requested result is saved.')
  expect(result.incomplete).toBeUndefined()
})

it('parks a partial collection at its reported barrier and retains it through output bookkeeping', async () => {
  const run = vi.fn(async (job: ToolSessionJob) => {
    const collect = job.tools.find(t => t.name === 'collect_results')!
    await collect.run({ items: Array.from({ length: 10 }, (_, i) => String(i)), fields: ['value'] })
    for (let i = 0; i < 3; i++) {
      await job.tools.find(t => t.name === 'open_page')!.run({})
      await collect.run({ item: String(i), values: { value: 'Visible result' }, evidenceStep: 2 + i * 2 })
    }
    await collect.run({ status: 'blocked', summary: 'Please sign in to read the remaining seven items.', evidenceStep: 6 })
    await job.tools.find(t => t.name === 'file_create_copy')!.run({})
    await job.tools.find(t => t.name === 'report_result_check')!.run({})
    return { answer: 'Continuing' }
  })
  const result = await runToolSession({ engine: engine(run), workdir, tools: [tool('open_page'), tool('file_create_copy', '{}'), tool('report_result_check', '{}')] }, 'Read ten items')
  expect(run).toHaveBeenCalledOnce()
  expect(result).toMatchObject({ asked: true, answer: 'Please sign in to read the remaining seven items.' })
  expect(result.incomplete).toBeUndefined()
})

it('directs a login-wall response into ask_person', async () => {
  const wall = { url: 'https://example.test', title: 'Sign in', text: 'Sign in', wall: 'login' as const }
  const tools = [...pageTools({}, { fetchPage: async () => wall, readOpen: async () => wall, press: async () => ({ ok: true }) }),
    { ...tool('ask_person'), run: async () => formatAsk('Please sign in and tell me when it is done.', []) }]
  const run = vi.fn(async (job: ToolSessionJob) => {
    const response = await job.tools.find(t => t.name === 'press')!.run({ target: 'Continue' })
    expect(String(response)).toContain('Call ask_person with this question:')
    await job.tools.find(t => t.name === 'ask_person')!.run({})
    return { answer: 'Continuing' }
  })
  const result = await runToolSession({ engine: engine(run), workdir, tools }, 'Read the report')
  expect(result.asked).toBe(true)
  expect(result.answer).toBe('Please sign in and tell me when it is done.')
  expect(run).toHaveBeenCalledOnce()
})
