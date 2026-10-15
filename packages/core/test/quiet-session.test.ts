import { expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { pickTools } from '../src/agent-prompt.js'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'

it.each([
  ['app_read', 'that did not work: window changed'],
  ['app_text', '{"settled":false,"text":"still streaming"}'],
  ['app_set', '{"landed":false,"exact":false}'],
])('does not present a failed %s result as complete', async (name, observation) => {
  const tool: AgentTool = { name, description: name, argsSchema: {}, run: async () => observation }
  const engine = {
    id: 'mock', desktopToolIsolation: true,
    runTools: async (job: ToolSessionJob) => {
      await job.tools.find(one => one.name === name)!.run({})
      return { answer: 'Task response' }
    },
  } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [tool] }, 'Inspect the requested app')
  expect(result.incomplete).toContain('not been verified')
})

it('offers quiet reads first and mutations only after observing the app', () => {
  const all: AgentTool[] = ['app_read', 'app_text', 'app_set', 'app_press', 'read_desktop', 'look_desktop'].map(name => ({ name, description: name, argsSchema: {}, run: async () => '' }))
  const opening = pickTools(all, 'Read the app', []).map(tool => tool.name)
  expect(opening.indexOf('app_read')).toBeLessThan(opening.indexOf('read_desktop'))
  const observed = pickTools(all, 'Edit the app', [{ tool: 'app_read', args: {}, observation: '{"snapshot":"fresh"}' }]).map(tool => tool.name)
  expect(observed).toEqual(expect.arrayContaining(['app_set', 'app_press']))
})
