import { expect, it } from 'vitest'
import { navigationTools } from '../src/comet-navigation-tools.js'
import { runToolSession } from '../src/agent-session.js'
import type { CometToolDeps } from '../src/comet-tools.js'
import type { Engine, EngineCwd } from '../src/engine/types.js'

it.each([
  ['open_page', 'Read the saved report', /sign in/],
  ['read_open_page', 'Read the saved report', /sign in/],
  ['open_page', '저장된 보고서 읽어줘', /로그인/],
  ['read_open_page', '저장된 보고서 읽어줘', /로그인/],
])('parks a login wall reached by %s for "%s" in the task language', async (name, task, expected) => {
  const page = { url: 'https://work.example/login', text: '', title: 'Login', wall: 'login' }
  const tools = navigationTools({ courier: { fetchPage: async () => page, readOpen: async () => page }, guided: false } as unknown as CometToolDeps)
  const engine = { runTools: async job => {
    await job.tools.find(tool => tool.name === name)!.run({ url: 'https://work.example/report' })
    return { answer: 'Continue searching' }
  } } as Engine
  const result = await runToolSession({ engine, tools, workdir: 'tmp' as EngineCwd }, task)
  expect(result.asked).toBe(true)
  expect(result.answer).toMatch(expected)
  if (/[가-힣]/.test(task)) expect(result.answer).not.toMatch(/sign in/i)
  expect(result.steps).toHaveLength(1)
})
