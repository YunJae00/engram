import { expect, it, vi } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd } from '../src/engine/types.js'

it.each([true, false])('measures repeated page steps only when decision is offered (%s)', async offered => {
  const onMetric = vi.fn()
  const engine: Engine = { runTools: async job => {
    for (let i = 0; i < 4; i++) await job.tools.find(tool => tool.name === 'page_steps')!.run({ steps: [] })
    return { answer: 'Observed' }
  } } as Engine
  const names = ['page_steps', ...(offered ? ['page_do'] : [])]
  await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: names.map(name => ({ name, description: name, argsSchema: {}, run: async () => 'Observed' })) }, 'Inspect', { onMetric })
  expect(onMetric.mock.calls.filter(([event]) => event.operation === 'decision-bypass')).toHaveLength(offered ? 1 : 0)
})

it('puts connected decision tools before manual navigation in the session rules', async () => {
  const { sessionShape } = await import('../src/agent-session-shape.js')
  const tools = ['app_do', 'app_read', 'page_do', 'open_page', 'page_steps'].map(name => ({ name, description: name, argsSchema: {}, run: async () => 'Observed' }))
  const shape = sessionShape({ engine: {} as Engine, tools })
  expect(shape.system).toContain('use app_do first')
  expect(shape.system).toContain('Use page_do first')
  expect(shape.system).not.toContain('use app_read, app_set, app_press and app_text first')
})
