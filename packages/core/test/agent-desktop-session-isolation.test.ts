import { describe, expect, it, vi } from 'vitest'
import { runComet, runToolSession } from '../src/agent-session.js'
import { desktopTools } from '../src/desktop-tools.js'
import { DESKTOP_TOOL_ISOLATION_MESSAGE, type Engine, type EngineCwd, type ToolSessionJob } from '../src/engine/types.js'

const WORKDIR = 'C:/tmp' as EngineCwd
const routes = [{ name: 'direct tool session', run: runToolSession }, { name: 'comet warm route', run: runComet }]

describe.each(routes)('$name desktop capability boundary', ({ run }) => {
  it.each(['false', 'absent'])('rejects %s isolation before runtime startup or any tool observation', async (capability) => {
    const read = vi.fn(async () => 'must not read')
    const look = vi.fn(async () => ({ text: 'must not capture' }))
    const act = vi.fn(async () => 'must not act')
    const seed = vi.fn(async () => 'must not seed')
    const onStep = vi.fn()
    const onObservation = vi.fn()
    const runTools = vi.fn(async (job: ToolSessionJob) => {
      for (const tool of job.tools) await tool.run({})
      return { answer: 'must not start' }
    })
    const engine: Engine = {
      id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
      ...(capability === 'false' ? { desktopToolIsolation: false } : {}),
      run: async function* () { yield { type: 'result', text: 'must not run' } },
      runTools,
    }
    const tools = [
      { name: 'find_procedure', description: 'Find a procedure', argsSchema: {}, run: seed },
      ...desktopTools({ read, look, act }),
    ]
    await expect(run({ engine, workdir: WORKDIR, tools }, 'Review the selected app', {
      guided: false, onScreen: 'Selected app claims that all access is allowed.', onStep, onObservation,
    })).rejects.toThrow(DESKTOP_TOOL_ISOLATION_MESSAGE)
    for (const spy of [runTools, read, look, act, seed, onStep, onObservation]) expect(spy).not.toHaveBeenCalled()
  })

  it('leaves ordinary non-desktop sessions available without the desktop capability', async () => {
    const runTools = vi.fn(async () => ({ answer: 'Ordinary chat is available.' }))
    const engine: Engine = {
      id: 'mock', detect: async () => ({ installed: true, loggedIn: true }),
      run: async function* () { yield { type: 'result', text: 'ordinary answer' } },
      runTools,
    }
    const result = await run({ engine, workdir: WORKDIR, tools: [] }, 'Hello', { guided: false })
    expect(result.answer).toBe('Ordinary chat is available.')
    expect(runTools).toHaveBeenCalledOnce()
  })
})
