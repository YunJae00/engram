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
