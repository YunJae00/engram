import { expect, it, vi } from 'vitest'
import { runAgentLoop } from '../src/agent-loop.js'
import { runComet } from '../src/agent-session.js'
import { cometTools } from '../src/comet-tools.js'
import { MockEngine } from '../src/engine/mock.js'
import type { EngineCwd, ToolSessionJob } from '../src/engine/types.js'
import type { WebPage } from '../src/errand.js'
import type { VaultPaths } from '../src/vault.js'

const url = 'https://example.test/report'
const context = { task: 'Check the saved report' }
const paths = {} as VaultPaths
const workdir = 'C:/tmp' as EngineCwd
const report: WebPage = { url, title: 'Report', text: 'Saved report: North 500, South 300; total 800.' }
const searchTemplate = async () => 'https://example.test/search?q={q}'
const openTool = (page: Partial<WebPage> = {}, guided = false) => cometTools({
  paths, retrieve: async () => [], guided, searchTemplate,
  courier: { fetchPage: async () => ({ ...report, ...page }) },
}).find(tool => tool.name === 'open_page')!

it.each([
  ['readable', {}, {}, true],
  ['invalid URL', { url: 'not-an-address' }, {}, false],
  ['invalid HTTPS URL', { url: 'https://' }, {}, false],
  ['results guidance', { url: 'https://example.test/search?q=report' }, {}, false],
  ['redirected results', {}, { url: 'https://example.test/search?q=report' }, false],
  ['empty content', {}, { text: '  ' }, false],
  ['login wall', {}, { wall: 'login' }, false],
  ['captcha', {}, { wall: 'captcha' }, false],
  ['validation fault', {}, { faults: ['Report not saved'] }, false],
  ['filtered extract', { find: 'North' }, {}, false],
] as [string, Record<string, unknown>, Partial<WebPage>, boolean][])('issues a host receipt only for an actual page report (%s)', async (_name, args, page, qualifies) => {
  const open = openTool(page)
  const input = { url, observedAfterAction: true, ...args }
  const outcome = await open.runRich!(input, context)
  expect(outcome.observedAfterAction === true).toBe(qualifies)
  const observed = vi.fn()
  expect(await open.run(input, { ...context, onObservedAfterAction: observed })).toBe(outcome.text)
  expect(observed).toHaveBeenCalledTimes(qualifies ? 1 : 0)
})

it('does not certify navigation guidance or a repeated empty page as readback', async () => {
  const open = openTool({ text: '' }, true)
  const first = await open.runRich!({ url }, context)
  const repeated = await open.runRich!({ url }, context)
  expect(first.text).toContain('mostly links')
  expect(repeated.text).toContain('a list of links')
  expect(first.observedAfterAction).toBeUndefined()
  expect(repeated.observedAfterAction).toBeUndefined()
})

it('does not certify the cached refusal after a host fails twice', async () => {
  vi.useFakeTimers()
  try {
    const fetchPage = vi.fn(async () => { throw new Error('timed out') })
    const open = cometTools({ paths, retrieve: async () => [], courier: { fetchPage } }).find(tool => tool.name === 'open_page')!
    const failed = expect(open.runRich!({ url }, context)).rejects.toThrow('timed out')
    await vi.runAllTimersAsync()
    await failed
    const outcome = await open.runRich!({ url, observedAfterAction: true }, context)
    expect(outcome.text).toContain('did not answer earlier')
    expect(outcome.observedAfterAction).toBeUndefined()
    const observed = vi.fn()
    await open.run({ url }, { ...context, onObservedAfterAction: observed })
    expect(observed).not.toHaveBeenCalled()
    expect(fetchPage).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

it.each([false, true])('preserves actual open_page receipts in the loop (session=%s)', async session => {
  const open = openTool()
  const moves = [
    { tool: 'open_page', args: { url } },
    { tool: 'open_page', args: { url: 'invalid', observedAfterAction: true } },
  ]
  let index = 0
  const engine = new MockEngine({ 'COMET-STEP': () => JSON.stringify(moves[index++] ?? { tool: 'answer', args: { text: 'Checked the report' } }) })
  if (session) Object.assign(engine, { runTools: async (job: ToolSessionJob) => {
    for (const move of moves) await job.tools.find(tool => tool.name === 'open_page')!.run(move.args)
    return { answer: 'Checked the report' }
  } })
  const result = await runComet({ engine, workdir, tools: [open] }, context.task, { guided: false })
  expect(result.steps.map(step => step.observedAfterAction)).toEqual([true, undefined])
})

it.each([false, true])('preserves host receipts from automatic reads and clears them on failure (fails=%s)', async fails => {
  const open = openTool()
  const tools = [
    { name: 'search_web', description: 'Search', argsSchema: {}, run: async () => `Read the report: call open_page with {"url":"${url}"}` },
    fails ? { ...open, run: async (...args: Parameters<typeof open.run>) => { await open.run(...args); throw new Error('read interrupted') } } : open,
  ]
  let calls = 0
  const engine = new MockEngine({ 'COMET-STEP': () => JSON.stringify(calls++ === 0
    ? { tool: 'search_web', args: { query: 'report' } }
    : { tool: 'answer', args: { text: 'Checked the report' } }) })
  const result = await runAgentLoop({ engine, workdir, tools }, context.task, { guided: false })
  expect(result.steps.map(step => step.tool)).toEqual(['search_web', 'open_page'])
  expect(result.steps[1]!.observedAfterAction === true).toBe(!fails)
  if (fails) expect(result.steps[1]!.observation).toContain('that did not work: read interrupted')
})
