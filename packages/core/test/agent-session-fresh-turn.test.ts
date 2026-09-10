import { expect, it } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'

it.each([true, false])('requests fresh turn evidence only for desktop tasks (desktop=%s)', async (desktop) => {
  const jobs: ToolSessionJob[] = []
  const engine = { desktopToolIsolation: true, runTools: async (job: ToolSessionJob) => {
    jobs.push(job)
    return { answer: 'No input dispatched' }
  } } as Engine
  const tools = [{ name: desktop ? 'read_desktop' : 'search_memory', description: 'Read', argsSchema: {}, run: async () => 'Observed' }]
  const deps = { engine, workdir: 'C:/tmp' as EngineCwd, tools }
  await runToolSession(deps, 'Inspect the current state', { session: 'same-session' })
  await runToolSession(deps, 'Continue with a different value', { session: 'same-session' })
  for (const job of jobs) {
    expect(job.prompt.includes('Prior-turn desktop observations are historical')).toBe(desktop)
    if (desktop) {
      expect(job.prompt).toContain('read_desktop or look_desktop before the first input this turn')
      expect(job.prompt).toContain('reuse fresh returned observations within this turn')
    }
    expect(job.system).not.toContain('Prior-turn desktop observations are historical')
  }
  expect(jobs[0]!.system).toBe(jobs[1]!.system)
})
