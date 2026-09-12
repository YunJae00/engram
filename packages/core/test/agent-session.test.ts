import { describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { runComet, runToolSession } from '../src/agent-session.js'
import { formatAsk } from '../src/ask.js'
import type { Engine, EngineCwd, ToolSessionJob, ToolSessionResult } from '../src/engine/types.js'

const WORKDIR = 'C:/tmp' as EngineCwd

// A brain that holds its own loop: it calls the tools it is handed in the
// order a script says, then answers.
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

it('offers method discovery for desktop and web work without saved-file tools', async () => {
  const read = vi.fn(async () => 'Unneeded observation')
  const available: AgentTool[] = ['read_desktop', 'desktop_sequence', 'open_page'].map(name => ({ name, description: name, argsSchema: {}, run: read }))
  const engine = sessionBrain(async job => {
    expect(job.system).toContain('not a fixed application recipe')
    const capability = job.tools.find(tool => tool.name === 'work_capabilities')!
    const result = JSON.parse(String(await capability.run({})).split('\n')[0]!)
    expect(result.desktop).toEqual(['read_desktop', 'desktop_sequence'])
    expect(result.web).toEqual(['open_page'])
    expect(result.savedFiles).toEqual([])
    expect(result.liveDocumentApi.available).toBe(false)
    return { answer: 'Available methods inspected; no actions taken' }
  })
  await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: available }, 'Inspect available execution methods')
  expect(read).not.toHaveBeenCalled()
})

describe('a tool session: the brain loops, the turn keeps the loop\'s shape', () => {
  it('hands the tools over with the persona in the system prompt and records every call as a step', async () => {
    const seen: { system: string; prompt: string; opening?: string; key?: string }[] = []
    const engine = sessionBrain(async (job) => {
      seen.push({ system: job.system, prompt: job.prompt, ...(job.opening ? { opening: job.opening } : {}), ...(job.sessionKey ? { key: job.sessionKey } : {}) })
      const search = job.tools.find((t) => t.name === 'search_memory')!
      const got = await search.run({ query: 'deploys' })
      return { answer: `From the notes: ${got}` }
    })
    const lines: string[] = []
    const result = await runToolSession({ engine, workdir: WORKDIR, tools }, 'what did we decide about deploys?', {
      persona: 'You are "Scout".',
      guided: false,
      session: 'bot-1',
      history: [{ role: 'user', text: 'earlier' }],
      onStep: (line) => lines.push(line),
    })
    // The rules stand in the system prompt; who speaks and what they want
    // travel with the turn; the conversation opens the session; the key
    // lets the brain keep it.
    expect(seen[0]!.system).toContain('language of their message')
    expect(seen[0]!.system).not.toContain('Scout')
    expect(seen[0]!.prompt).toContain('You are "Scout".')
    expect(seen[0]!.prompt).toContain('Task: what did we decide about deploys?')
    expect(seen[0]!.opening).toContain('User: earlier')
    expect(seen[0]!.key).toBe('bot-1')
    expect(result.steps.map((s) => s.tool)).toEqual(['search_memory'])
    expect(result.answer).toBe('From the notes: notes about deploys')
    expect(lines).toEqual(['search_memory: deploys'])
    expect(result.asked).toBeUndefined()
  })

  it('a question to the person ends the turn as an ask, whatever the brain says afterwards', async () => {
    const engine = sessionBrain(async (job) => {
      const ask = job.tools.find((t) => t.name === 'ask_person')!
      const told = await ask.run({ question: 'Which site?' })
      expect(told).toContain('with the person')
      return { answer: 'Let me know which site.' }
    })
    const result = await runToolSession({ engine, workdir: WORKDIR, tools }, 'upload the report', { guided: false })
    expect(result.asked).toBe(true)
    expect(result.answer).toBe('Which site?')
    expect(result.options).toEqual(['A', 'B'])
  })

  it('a brain without a session, or a guided turn, goes through the step loop', async () => {
    const stepOnly = sessionBrain(async () => ({ answer: 'session answer' }))
    delete (stepOnly as { runTools?: unknown }).runTools
    const viaLoop = await runComet({ engine: stepOnly, workdir: WORKDIR, tools }, 'hello', { guided: false })
    expect(viaLoop.answer).toContain('step loop answer')
    const guided = await runComet({ engine: sessionBrain(async () => ({ answer: 'session answer' })), workdir: WORKDIR, tools }, 'hello', { guided: true })
    expect(guided.answer).toContain('step loop answer')
    const session = await runComet({ engine: sessionBrain(async () => ({ answer: 'session answer' })), workdir: WORKDIR, tools }, 'hello', { guided: false })
    expect(session.answer).toBe('session answer')
  })

  it('a session that failed is an error, not an empty answer', async () => {
    const engine = sessionBrain(async () => ({ answer: '', error: 'timed out after 1ms' }))
    await expect(runToolSession({ engine, workdir: WORKDIR, tools }, 'hello', { guided: false })).rejects.toThrow(/timed out/)
  })
})

describe('what the person said earlier is a source for a blank', () => {
  it('a "yes, go ahead" turn keeps the room and time from the message before it', async () => {
    const seen: { task: string; read?: string }[] = []
    const engine = sessionBrain(async (job) => {
      const tool = job.tools.find((t) => t.name === 'search_memory')!
      await tool.run({ query: 'x' })
      return { answer: 'done' }
    })
    const spy: AgentTool = {
      name: 'search_memory',
      description: 'search',
      argsSchema: {},
      run: async (_args, context) => {
        seen.push({ task: context.task, ...(context.read !== undefined ? { read: context.read } : {}) })
        return 'nothing'
      },
    }
    await runToolSession({ engine, workdir: WORKDIR, tools: [spy] }, '네, 진행해주세요', {
      guided: false,
      history: [
        { role: 'user', text: '회의실 B 모레 오전 11시 예약해줘' },
        { role: 'assistant', text: '오늘 이미 실행했는데 다시 할까요?' },
      ],
    })
    expect(seen[0]!.read).toContain('회의실 B 모레 오전 11시')
  })
})

describe('looking comes before asking', () => {
  it('the first question of a turn, before any search, is sent to the search; asked again after looking, it goes through', async () => {
    const heard: string[] = []
    const engine = sessionBrain(async (job) => {
      const ask = job.tools.find((t) => t.name === 'ask_person')!
      const search = job.tools.find((t) => t.name === 'search_web')!
      heard.push(String(await ask.run({ question: 'Which report?' })))
      heard.push(String(await search.run({ query: 'the report' })))
      heard.push(String(await ask.run({ question: 'Which report?' })))
      return { answer: 'ignored' }
    })
    const withSearch: AgentTool[] = [...tools, { name: 'search_web', description: 'search', argsSchema: {}, run: async () => 'nothing came back' }]
    const result = await runToolSession({ engine, workdir: WORKDIR, tools: withSearch }, 'summarise the report', { guided: false })
    expect(heard[0]).toContain('Look before you ask')
    expect(heard[0]).toContain('search_web')
    expect(heard[1]).toBe('nothing came back')
    expect(result.asked).toBe(true)
    expect(result.answer).toBe('Which report?')
  })
})

it('retains an incomplete phase and stops unproductive calls without granting a fresh budget', async () => {
  let reads = 0
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare workspace', 'Verify changes'] })
    for (let index = 0; index < 45; index++) await read.run({})
    return { answer: 'Incomplete' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => { reads++; return 'Observed workspace' } }] }, 'Perform the requested changes')
  expect(reads).toBe(39)
  expect(result.stopped).toBe('calls')
  expect(result.incomplete).toContain('Prepare workspace')
})

it('adds bounded execution room after an observed phase, retaining one session', async () => {
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare workspace', 'Verify changes'] })
    await read.run({})
    await plan.run({ evidenceStep: 2, finding: 'The requested workspace is visible' })
    for (let index = 0; index < 40; index++) await read.run({})
    await plan.run({ evidenceStep: 43, finding: 'Requested result visible' })
    return { answer: 'Verified' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => 'Observed workspace' }] }, 'Perform the requested changes')
  expect(result.steps).toHaveLength(44)
  expect(result.stopped).toBeUndefined()
  expect(result.incomplete).toBeUndefined()
})

it('accepts the fresh phase checkpoint at the execution allowance boundary', async () => {
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare workspace', 'Verify changes'] })
    for (let index = 0; index < 39; index++) await read.run({})
    expect(await plan.run({ evidenceStep: 40, finding: 'The requested workspace is visible' })).toContain('"completed":1')
    await read.run({})
    await plan.run({ evidenceStep: 42, finding: 'Requested result visible' })
    return { answer: 'Verified' }
  })
  const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => 'Observed workspace' }] }, 'Perform requested changes')
  expect(result.steps).toHaveLength(43)
  expect(result.stopped).toBeUndefined()
  expect(result.incomplete).toBeUndefined()
})

it.each(['failed-observation', 'reused-evidence', 'expired'] as const)('does not replenish the boundary allowance from %s', async (cause) => {
  let reads = 0
  const clock = vi.spyOn(Date, 'now')
  const engine = sessionBrain(async (job) => {
    const plan = job.tools.find((tool) => tool.name === 'task_plan')!
    const read = job.tools.find((tool) => tool.name === 'read_desktop')!
    await plan.run({ phases: ['Prepare workspace', 'Verify changes'] })
    for (let index = 0; index < 39; index++) await read.run({})
    if (cause === 'expired') clock.mockReturnValue(Date.now() + 600001)
    const checkpoint = { evidenceStep: cause === 'reused-evidence' ? 2 : 40, finding: 'Ready' }
    expect(await plan.run(checkpoint)).not.toContain('"completed":1')
    expect(await plan.run(checkpoint)).toContain('No more calls')
    expect(await read.run({})).toContain('No more calls')
    return { answer: 'Incomplete' }
  })
  try {
    const result = await runToolSession({ engine: { ...engine, desktopToolIsolation: true }, workdir: WORKDIR, tools: [{ name: 'read_desktop', description: 'read', argsSchema: {}, run: async () => { reads++; return cause === 'failed-observation' ? 'that did not work: scan failed' : 'Observed workspace' } }] }, 'Perform requested changes')
    expect(reads).toBe(39)
    expect(result.stopped).toBe('calls')
    expect(result.incomplete).toContain('Prepare workspace')
  } finally { clock.mockRestore() }
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
  expect(result.incomplete).toContain('5/5')
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
