import { finalDesktopFailure } from '../src/agent-session-result.js'
import { expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runToolSession, SESSION_MAX_CALLS } from '../src/agent-session.js'
import { formatAsk } from '../src/ask.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

const WORKDIR = 'C:/tmp' as EngineCwd

function sessionBrain(script: (job: ToolSessionJob) => Promise<ToolSessionResult>): Engine {
  return {
    id: 'mock',
    detect: async () => ({ installed: true, loggedIn: true }),
    run: async function* () {
      yield { type: 'result', text: 'step loop answer' }
    },
    runTools: script,
  } as unknown as Engine
}

const tools: AgentTool[] = [
  { name: 'search_memory', description: 'search', argsSchema: { type: 'object', properties: { query: { type: 'string' } } }, run: async (args) => `notes about ${String(args['query'])}` },
  { name: 'ask_person', description: 'ask', argsSchema: { type: 'object', properties: { question: { type: 'string' } } }, run: async (args) => formatAsk(String(args['question']), ['A', 'B']) },
]

it('keeps the hard session cap even with a fresh phase checkpoint', async () => {
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare workspace', 'Verify changes'] })
    for (let index = 0; index < SESSION_MAX_CALLS - 1; index++) await read.run({})
    expect(await plan.run({ evidenceStep: SESSION_MAX_CALLS, finding: 'The requested workspace is visible' })).toContain('No more calls')
    await read.run({})
    await plan.run({ evidenceStep: SESSION_MAX_CALLS + 2, finding: 'Requested result visible' })
    return { answer: 'Verified' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => 'Observed workspace' }] }, 'Perform requested changes')
  expect(result.steps).toHaveLength(SESSION_MAX_CALLS)
  expect(result.stopped).toBe('calls')
  expect(result.incomplete).toBeUndefined()
})

it.each(['failed-observation', 'reused-evidence'] as const)('does not replenish the boundary allowance from %s', async (cause) => {
  let reads = 0
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare workspace', 'Verify changes'] })
    for (let index = 0; index < SESSION_MAX_CALLS - 1; index++) await read.run({})
    const checkpoint = { evidenceStep: cause === 'reused-evidence' ? 2 : SESSION_MAX_CALLS, finding: 'Ready' }
    expect(await plan.run(checkpoint)).not.toContain('"completed":1')
    expect(await plan.run(checkpoint)).toContain('No more calls')
    expect(await read.run({})).toContain('No more calls')
    return { answer: 'Incomplete' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => { reads++; return cause === 'failed-observation' ? 'that did not work: scan failed' : 'Observed workspace' } }] }, 'Perform requested changes')
  expect(reads).toBe(SESSION_MAX_CALLS - 1)
  expect(result.stopped).toBe('calls')
  if (cause === 'failed-observation') expect(result.incomplete).toContain('failed')
  else expect(result.incomplete).toBeUndefined()
})

it('lets browser work go past its allowance without judging whether each observation is new', async () => {
  let opened = 0
  const engine = sessionBrain(async (job) => {
    const open = job.tools.find((tool) => tool.name === 'open_page')!
    for (let page = 0; page < 130; page++) expect(await open.run({ url: `https://x.example/${page}` })).not.toContain('No more calls')
    for (let again = 0; again < 2; again++) await open.run({ url: 'https://x.example/0' })
    expect(await open.run({ url: 'https://x.example/0' })).not.toContain('No more calls')
    return { answer: 'Read them all' }
  })
  await runToolSession({ engine, workdir: WORKDIR, tools: [{ name: 'open_page', description: 'open', argsSchema: {}, run: async (args) => { opened++; return `page ${String(args['url'])}` } }] }, 'Read every page')
  expect(opened).toBe(133)
})

it('keeps the total 120-call ceiling even when a fresh phase checkpoint is available', async () => {
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare', 'Edit', 'Review', 'Validate', 'Verify'] })
    let steps = 1
    for (const boundary of [40, 60, 80, 100]) {
      while (steps < boundary) { await read.run({}); steps++ }
      expect(await plan.run({ evidenceStep: steps, finding: 'Phase result visible' })).toContain('"completed"')
      steps++
    }
    while (steps < 120) { await read.run({}); steps++ }
    expect(await plan.run({ evidenceStep: 120, finding: 'Final result visible' })).toContain('No more calls')
    return { answer: 'Incomplete' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => 'Observed workspace' }] }, 'Perform requested changes')
  expect(result.steps).toHaveLength(120)
  expect(result.stopped).toBe('calls')
  expect(result.incomplete).toBeUndefined()
})

it.each(['that did not work: target changed', '{"error":"Target was replaced"}', '{"observationMayBeStale":true}'])('marks the final failed desktop result incomplete: %s', async (failure) => {
  let actions = 0
  const engine = sessionBrain(async (job) => {
    const act = job.tools.find((tool) => tool.name === 'desktop_action')!
    for (let index = 0; index < 3; index++) await act.run({})
    return { answer: 'Stopped at the first unsuccessful action' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'desktop_action', description: 'act', argsSchema: {}, run: async () => ++actions === 3 ? failure : '{"observation":{"snapshot":"fresh"}}' }] }, 'Perform requested changes')
  expect(result.incomplete).toContain('not been verified')
  expect(!result.asked && !result.stopped && !result.pending && !result.incomplete).toBe(false)
})

it.each(['desktop_action', 'read_desktop'])('does not retain an earlier desktop error after a fresh %s result', async (lastTool) => {
  let failed = false
  const engine = sessionBrain(async (job) => {
    await job.tools.find((tool) => tool.name === 'desktop_action')!.run({})
    await job.tools.find((tool) => tool.name === lastTool)!.run({})
    return { answer: 'The requested result is now visible' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [
    { name: 'desktop_action', description: 'act', argsSchema: {}, run: async () => {
      if (!failed) { failed = true; return '{"error":"Target changed"}' }
      return '{"dispatched":true,"observation":{"snapshot":"fresh"}}'
    } },
    { name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => '{"snapshot":"fresh","nodes":[]}' },
  ] }, 'Perform requested changes')
  expect(result.incomplete).toBeUndefined()
})

it.each([
  ['edit_live_document', false], ['edit_live_document', true],
  ['compose_live_document', false], ['compose_live_document', true],
] as const)('requires fresh verification after %s (reread=%s)', async (method, reread) => {
  const engine = sessionBrain(async (job) => {
    await job.tools.find(tool => tool.name === method)!.run({})
    if (reread) await job.tools.find(tool => tool.name === 'read_live_document')!.run({})
    return { answer: 'The document is complete' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [
    { name: method, description: 'edit', argsSchema: {}, run: async () => JSON.stringify({ live: true, completed: [], completeReadback: false, error: method === 'edit_live_document' ? 'Content changed' : null, reobserveRequired: true }) },
    { name: 'read_live_document', description: 'read', argsSchema: {}, run: async () => JSON.stringify({ live: true, blocks: [{ id: 'b0', text: 'Observed result' }] }) },
  ] }, 'Update the open document')
  expect(!!result.incomplete).toBe(!reread)
})

it.each([false, true])('a written document is not complete until it is read back (reread=%s)', async (reread) => {
  const engine = sessionBrain(async (job) => {
    await job.tools.find((tool) => tool.name === 'excel_write')!.run({})
    if (reread) await job.tools.find((tool) => tool.name === 'excel_read')!.run({})
    return { answer: 'The income statement is ready' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [
    { name: 'excel_write', description: 'write', argsSchema: {}, run: async () => JSON.stringify({ workbook: 'book.xlsx', sheet: 'Sheet1', written: 4, saved: 'C:/book.xlsx' }) },
    { name: 'excel_read', description: 'read', argsSchema: {}, run: async () => JSON.stringify({ workbook: 'book.xlsx', sheet: 'Sheet1', range: 'A1:B2', rows: [[1, 2], [3, 4]] }) },
  ] }, 'Build the income statement')
  // Generated but never read back → honestly marked not verified; read back → done.
  expect(!!result.incomplete).toBe(!reread)
  if (!reread) expect(result.incomplete).toContain('read back')
})

it('a failed office write is marked not verified', async () => {
  const engine = sessionBrain(async (job) => {
    await job.tools.find((tool) => tool.name === 'ppt_build')!.run({})
    return { answer: 'The deck is built' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [
    { name: 'ppt_build', description: 'build', argsSchema: {}, run: async () => 'that did not work: the deck did not read clean' },
  ] }, 'Build the proposal deck')
  expect(result.incomplete).toContain('read back')
  expect(result.answer).toContain('Not verified as complete')
})

it('resumes an unfinished job instead of restarting it', async () => {
  let seenPrompt = ''
  const engine = sessionBrain(async (job) => { seenPrompt = job.prompt; return { answer: 'Continuing from where it stopped' } })
  await runToolSession({ engine, workdir: WORKDIR, tools }, 'keep going', {
    guided: false,
    resume: 'Unverified phase 2/3: post the reconciled totals',
  })
  expect(seenPrompt).toContain('Historical checkpoint')
  expect(seenPrompt).toContain('post the reconciled totals')
  expect(seenPrompt).toContain('do only the unfinished work')
  expect(seenPrompt).toContain('new or unrelated request, ignore it')
})

it('applies arithmetic verification to the real tool-session path and accepts corrected readback', async () => {
  for (const corrected of [false, true]) {
    let calls = 0
    const engine = sessionBrain(async (job) => {
      const read = job.tools.find(tool => tool.name === 'excel_read')!
      await read.run({})
      if (corrected) await read.run({})
      return { answer: 'Done' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: [{ name: 'excel_read', description: 'read', argsSchema: {}, run: async () => JSON.stringify({ workbook: 'B', sheet: 'S', range: 'A1:A3', rows: [[10], [20], [++calls > 1 ? 30 : 99]], formulas: [[10], [20], ['=SUM(A1:A2)']] }) }] }, 'Verify the total')
    expect(!!result.incomplete).toBe(!corrected)
  }
})


it('discloses registered collection items left without a finish receipt', async () => {
  const engine = sessionBrain(async job => {
    await job.tools.find(tool => tool.name === 'collect_results')!.run({ items: ['Movie'], fields: ['showtime'] })
    return { answer: 'All done.' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [{ name: 'open_page', description: 'read', argsSchema: {}, run: async () => 'Movie' }] }, 'Read movie showtimes')
  expect(result.incomplete).toContain('collection items remain unverified')
  expect(result.answer).toContain('Not verified as complete')
})

it('distinguishes an attempted last-page failure from unfinished batch reads', () => {
  const pages = [{ url: 'https://example.test/a', ready: true, observation: 'A' }, { url: 'https://example.test/b', ready: false, observation: 'HTTP 403' }]
  const step = (requested: number) => [{ tool: 'read_pages', args: {}, observation: JSON.stringify({ completed: 1, requested, pages }) }]
  expect(finalDesktopFailure(step(2))).toBeUndefined()
  expect(finalDesktopFailure(step(3))).toContain('stopped before all pages')
})

it.each(['app_read', 'app_text', 'look_desktop'])('keeps a structured %s failure incomplete', tool => {
  expect(finalDesktopFailure([{ tool, args: {}, observation: JSON.stringify({ error: 'policy_denied', delivery: 'not_delivered', retry: 'safe', hint: 'Manual control required' }) }])).toContain('has not been verified')
})

it('separates accepted app launch from a permission-blocked readback', () => {
  expect(finalDesktopFailure([
    { tool: 'open_app', args: {}, observation: JSON.stringify({ opened: true, windowVerified: false }) },
    { tool: 'app_read', args: {}, observation: JSON.stringify({ error: 'accessibility_denied', retry: 'blocked' }) },
  ])).toBeUndefined()
  expect(finalDesktopFailure([{ tool: 'app_set', args: {}, observation: JSON.stringify({ landed: false }) }])).toContain('has not been verified')
})

it('finishes a blocked collection once without rewriting it as incomplete', async () => {
  const engine = sessionBrain(async job => {
    await job.tools.find(tool => tool.name === 'open_page')!.run({})
    await job.tools.find(tool => tool.name === 'collect_results')!.run({ status: 'blocked', summary: 'Sign in to continue.', evidenceStep: 1 })
    return { answer: 'Sign in to continue.' }
  })
  const result = await runToolSession({ engine, workdir: WORKDIR, tools: [{ name: 'open_page', description: 'read', argsSchema: {}, run: async () => 'The page needs the person to sign in or pass a check.' }] }, 'Read the report')
  expect(result.answer).toBe('Sign in to continue.')
  expect(result.asked).toBe(true)
  expect(result.incomplete).toBeUndefined()
  expect(result.stopped).toBeUndefined()
})
