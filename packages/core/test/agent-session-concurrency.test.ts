import { expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'

const workdir = 'C:/tmp' as EngineCwd
function engine(run: (job: ToolSessionJob) => Promise<void>, desktop = true, answer = 'Observed'): Engine {
  return { desktopToolIsolation: desktop, runTools: async (job: ToolSessionJob) => { await run(job); return { answer } } } as Engine
}
function read(run: AgentTool['run'], desktop = true): AgentTool {
  return { name: desktop ? 'read_desktop' : 'search_memory', description: 'Read', argsSchema: {}, run }
}

it('orders overlapping desktop callbacks without overlapping observations', async () => {
  let active = 0, peak = 0
  const order: number[] = []
  const result = await runToolSession({ workdir, engine: engine(async (job) => {
    await Promise.all(Array.from({ length: 4 }, (_, index) => job.tools[0]!.run({ index })))
  }), tools: [read(async (args) => {
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    order.push(Number(args['index']))
    active--
    return 'Fresh observation'
  })] }, 'Inspect the selected workspace')
  expect(peak).toBe(1)
  expect(order).toEqual([0, 1, 2, 3])
  expect(result.steps).toHaveLength(4)
})

it.each([true, false])('counts in-flight calls against the hard allowance (desktop=%s)', async (desktop) => {
  let dispatched = 0
  const result = await runToolSession({ workdir, engine: engine(async (job) => {
    await Promise.all(Array.from({ length: 150 }, () => job.tools[0]!.run({})))
  }, desktop), tools: [read(async () => { dispatched++; await Promise.resolve(); return 'Fresh observation' }, desktop)] }, 'Inspect the workspace')
  expect(dispatched).toBe(40)
  expect(result.steps).toHaveLength(40)
  expect(result.stopped).toBe('calls')
})

it('checks a queued phase checkpoint only after the cited observation completes', async () => {
  const result = await runToolSession({ workdir, engine: engine(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    await plan.run({ phases: ['Inspect', 'Verify'] })
    const observation = job.tools[0]!.run({})
    const checkpoint = plan.run({ evidenceStep: 2, finding: 'The workspace is visible' })
    await observation
    expect(await checkpoint).toContain('"completed":1')
  }), tools: [read(async () => { await Promise.resolve(); return 'Fresh observation' })] }, 'Inspect and verify the workspace')
  expect(result.steps.map((step) => step.tool)).toEqual(['task_plan', 'read_desktop', 'task_plan'])
  expect(result.incomplete).toContain('2/2')
})

it('does not dispatch a queued desktop call after cancellation', async () => {
  const controller = new AbortController()
  let dispatched = 0
  await expect(runToolSession({ workdir, engine: engine(async (job) => {
    const results = await Promise.allSettled([job.tools[0]!.run({}), job.tools[0]!.run({})])
    expect(results[1]!.status).toBe('rejected')
  }), tools: [read(async () => { dispatched++; await Promise.resolve(); controller.abort(); return 'Fresh observation' })] }, 'Inspect', { signal: controller.signal })).rejects.toThrow()
  expect(dispatched).toBe(1)
})

it('does not dispatch callbacks after the engine has ended its session', async () => {
  let lateCall: (() => ReturnType<ToolSessionJob['tools'][number]['run']>) | undefined
  let dispatched = 0
  await runToolSession({ workdir, engine: engine(async (job) => { lateCall = () => job.tools[0]!.run({}) }), tools: [read(async () => { dispatched++; return 'Fresh observation' })] }, 'Inspect')
  await expect(lateCall!()).rejects.toThrow(/session.*ended/)
  expect(dispatched).toBe(0)
})

it('aborts unfinished tools and drops queued input when the engine returns early', async () => {
  let dispatched = 0
  let outcomes: Promise<PromiseSettledResult<unknown>[]> | undefined
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const result = await runToolSession({ workdir, engine: engine(async (job) => {
    outcomes = Promise.allSettled([job.tools[0]!.run({}), job.tools[0]!.run({})])
    await started
  }), tools: [read(async (_args, context) => {
    dispatched++
    entered()
    await new Promise<void>((resolve) => context.signal!.addEventListener('abort', () => resolve(), { once: true }))
    return 'A late result is not proof'
  })] }, 'Inspect')
  expect(result.incomplete).toContain('before all requested tool results')
  expect((await outcomes!).every((outcome) => outcome.status === 'rejected')).toBe(true)
  expect(dispatched).toBe(1)
  expect(result.steps).toHaveLength(0)
})

it('keeps non-desktop tools parallel within their reserved allowance', async () => {
  let active = 0, peak = 0
  await runToolSession({ workdir, engine: engine(async (job) => {
    await Promise.all([job.tools[0]!.run({}), job.tools[0]!.run({})])
  }, false), tools: [read(async () => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; return 'Found' }, false)] }, 'Search')
  expect(peak).toBe(2)
})

it('keeps dispatched but unverified input incomplete and does not replay it', async () => {
  let dispatched = 0
  const result = await runToolSession({ workdir, engine: engine(async (job) => { await job.tools[0]!.run({}) }), tools: [{
    name: 'desktop_action', description: 'Act', argsSchema: {}, run: async () => {
      dispatched++
      return '{"dispatched":true,"error":"Readback failed","observationMayBeStale":true,"requiresVerification":true}'
    },
  }] }, 'Change the selected field')
  expect(result.incomplete).toContain('not been verified')
  expect(dispatched).toBe(1)
})

it('keeps concurrent callbacks within the total ceiling after verified phase allowances', async () => {
  const result = await runToolSession({ workdir, engine: engine(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    await plan.run({ phases: ['Prepare', 'Edit', 'Review', 'Validate', 'Finish'] })
    for (let phase = 0; phase < 4; phase++) {
      await job.tools[0]!.run({})
      await plan.run({ evidenceStep: 2 + phase * 2, finding: 'The phase result is visible' })
    }
    await Promise.all(Array.from({ length: 150 }, () => job.tools[0]!.run({})))
  }), tools: [read(async () => { await Promise.resolve(); return 'Fresh observation' })] }, 'Perform the requested changes')
  expect(result.steps).toHaveLength(120)
  expect(result.stopped).toBe('calls')
  expect(result.incomplete).toContain('5/5')
})

it.each(['unverified', 'exhausted'] as const)('labels an unsupported completion claim explicitly when %s', async (state) => {
  const result = await runToolSession({ workdir, engine: engine(async (job) => {
    for (let call = 0; call < (state === 'exhausted' ? 41 : 1); call++) await job.tools[0]!.run({})
  }, true, 'Everything completed'), tools: [{ name: 'desktop_action', description: 'Act', argsSchema: {}, run: async () => state === 'unverified'
    ? '{"dispatched":true,"error":"Readback failed","observationMayBeStale":true}'
    : '{"observation":{"snapshot":"fresh"}}',
  }] }, 'Change the field')
  expect(result.answer).toMatch(/^Not verified as complete\./)
  expect(result.answer).toContain('Unverified response:\nEverything completed')
})

it('does not admit a plan revision at the exhausted phase boundary', async () => {
  let revision = ''
  const result = await runToolSession({ workdir, engine: engine(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    await plan.run({ phases: ['Prepare', 'Verify'] })
    for (let call = 0; call < 39; call++) await job.tools[0]!.run({})
    revision = String(await plan.run({ remainingPhases: ['Revised work', 'Verify'], evidenceStep: 40, finding: 'The layout changed' }))
  }), tools: [read(async () => 'Fresh observation')] }, 'Change the field')
  expect(revision).toContain('No more calls')
  expect(result.steps).toHaveLength(40)
  expect(result.incomplete).toContain('Prepare')
})
