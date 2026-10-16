import { expect, it } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd } from '../src/engine/types.js'

it.each(['blocked', 'unsure', 'steps-exhausted', 'needs-person', 'done'])('keeps app_do status %s in final verification', async status => {
  const engine: Engine = {
    id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () { yield { type: 'result', text: '' } },
    runTools: async job => { await job.tools.find(tool => tool.name === 'app_do')!.run({}); return { answer: 'Finished' } },
  }
  const result = await runToolSession({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [{ name: 'app_do', description: 'Routine', argsSchema: {}, run: async () => JSON.stringify({ status }) }] }, 'Open the draft')
  expect(!!result.incomplete).toBe(status !== 'done')
})

it.each(['app_set', 'app_press'])('keeps %s readback failures incomplete with a combined receipt', async tool => {
  const engine: Engine = {
    id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () { yield { type: 'result', text: '' } },
    runTools: async job => { await job.tools.find(one => one.name === tool)!.run({}); return { answer: 'Finished' } },
  }
  const run = async () => JSON.stringify({ landed: true, exact: true, observationMayBeStale: true, error: 'Readback unavailable' })
  const result = await runToolSession({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [{ name: tool, description: 'Action', argsSchema: {}, run }] }, 'Open the draft')
  expect(result.incomplete).toBeTruthy()
})
