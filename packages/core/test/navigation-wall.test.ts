import { expect, it } from 'vitest'
import { navigationTools } from '../src/comet-navigation-tools.js'
import { runToolSession } from '../src/agent-session.js'
import type { CometToolDeps } from '../src/comet-tools.js'
import type { Engine, EngineCwd } from '../src/engine/types.js'

it.each(['open_page', 'read_open_page'])('parks a login wall reached by %s without another search', async name => {
  const page = { url: 'https://work.example/login', text: '', title: 'Login', wall: 'login' }
  const tools = navigationTools({ courier: { fetchPage: async () => page, readOpen: async () => page }, guided: false } as unknown as CometToolDeps)
  const engine = { runTools: async job => {
    await job.tools.find(tool => tool.name === name)!.run({ url: 'https://work.example/report' })
    return { answer: 'Continue searching' }
  } } as Engine
  const result = await runToolSession({ engine, tools, workdir: 'tmp' as EngineCwd }, 'Read the saved report')
  expect(result.asked).toBe(true)
  expect(result.answer).toMatch(/sign in/)
  expect(result.steps).toHaveLength(1)
})
