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
