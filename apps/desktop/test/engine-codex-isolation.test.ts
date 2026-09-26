import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineCwd, EngineEvent } from 'core'

const fixture = vi.hoisted(() => ({
  ready: vi.fn(), options: vi.fn(), threadOptions: vi.fn(), run: vi.fn(), binary: vi.fn(), settings: vi.fn(), query: vi.fn(), catalog: vi.fn(),
}))
vi.mock('../src/main/claude-runtime.js', () => ({ afterFirstClaudeSession: fixture.ready, claudeSessionStarted: () => {}, installedClaudeBinary: fixture.binary, loadClaudeSdk: async () => ({ query: fixture.query }) }))
vi.mock('../src/main/codex-turn.js', () => ({
  runCodexTurn: async (request: import('../src/main/codex-turn.js').CodexTurn, signal: AbortSignal) => {
    fixture.options(request.options)
    fixture.threadOptions(request.thread)
    return (await fixture.run(request.input, { outputSchema: request.outputSchema, signal })).finalResponse
  },
}))
vi.mock('../src/main/engine-cloud.js', async (original) => ({
  ...await original<typeof import('../src/main/engine-cloud.js')>(),
  codexBinary: fixture.binary,
  claudeBinary: fixture.binary,
  runText: fixture.catalog,
  withHelpersOnPath: () => ({ PATH: 'fixture-runtime-path' }),
}))
vi.mock('../src/main/settings.js', () => ({ loadSettings: fixture.settings }))
import { CodexEngine } from '../src/main/engine-codex.js'
import { ClaudeEngine, fetchClaudeModels, forgetClaudeModels } from '../src/main/engine-claude.js'

const WORKDIR = 'C:/tmp' as EngineCwd
async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const result: EngineEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.ready.mockResolvedValue(undefined)
  fixture.binary.mockReturnValue('fixture-codex')
  fixture.catalog.mockResolvedValue({ code: 0, out: '[{"name":"fixture","transport":{"command":"node"}}]' })
  fixture.settings.mockResolvedValue({ codexModel: 'chosen-model', claudeModel: 'chosen-model' })
  fixture.run.mockResolvedValue({ finalResponse: 'fixture answer' })
  fixture.query.mockImplementation(async function* () { yield { type: 'result', subtype: 'success', result: 'fixture answer' } })
})

describe('text runtime desktop isolation boundary', () => {
  it('does not spend model discovery timeout waiting for the first session', async () => {
    vi.useFakeTimers()
    forgetClaudeModels()
    try {
      fixture.ready.mockImplementationOnce(() => new Promise(resolve => setTimeout(resolve, 45_000)))
      fixture.query.mockImplementationOnce(() => ({ supportedModels: async () => {
        await new Promise(resolve => setTimeout(resolve, 30_000))
        return [{ value: 'fixture', displayName: 'Fixture', description: 'Test model' }]
      } }))
      const pending = fetchClaudeModels()
      await vi.advanceTimersByTimeAsync(75_000)
      expect(await pending).toEqual([expect.objectContaining({ value: 'fixture' })])
    } finally { forgetClaudeModels(); vi.useRealTimers() }
  })
  it('forwards explicit effort to both runtimes instead of the fast hint', async () => {
    await collect(new CodexEngine().run({ prompt: 'Read', workdir: WORKDIR, model: 'fixture', modelHint: 'fast', effort: 'high' }))
    expect(fixture.threadOptions).toHaveBeenLastCalledWith(expect.objectContaining({ modelReasoningEffort: 'high' }))
    await collect(new ClaudeEngine().run({ prompt: 'Read', workdir: WORKDIR, model: 'fixture', effort: 'medium' }))
    expect(fixture.query).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ effort: 'medium' }) }))
  })
  it('uses explicit per-job models, including Auto, instead of the global model', async () => {
    await collect(new CodexEngine().run({ prompt: 'Read', workdir: WORKDIR, model: 'conversation-model' }))
    expect(fixture.threadOptions).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'conversation-model' }))
    await collect(new CodexEngine().run({ prompt: 'Read', workdir: WORKDIR, model: '' }))
    expect(fixture.threadOptions.mock.lastCall?.[0]).not.toHaveProperty('model')
    await collect(new ClaudeEngine().run({ prompt: 'Read', workdir: WORKDIR, model: 'filing-model' }))
    expect(fixture.query).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ model: 'filing-model' }) }))
    expect(fixture.settings).not.toHaveBeenCalled()
  })
  it('passes attached images using the native local_image SDK input', async () => {
    const image = 'C:/fixture/workspace/.engram/chat-attachments/chart.png'
    await collect(new CodexEngine().run({ prompt: 'Read this chart', workdir: WORKDIR, imagePaths: [image], disallowTools: true }))
    expect(fixture.run).toHaveBeenCalledWith([{ type: 'text', text: 'Read this chart' }, { type: 'local_image', path: image }], expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
  it('bars inherited MCP and built-in tools in an isolated plain-text request', async () => {
    const engine = new ClaudeEngine()
    expect(engine.desktopToolIsolation).toBe(true)
    const events = await collect(engine.run({ prompt: 'Read the supplied observation', workdir: WORKDIR, disallowTools: true, requireToolIsolation: true }))
    expect(events).toEqual([{ type: 'result', text: 'fixture answer' }])
    expect(fixture.query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ tools: [], strictMcpConfig: true, settingSources: [] }) }))
    expect(fixture.options).not.toHaveBeenCalled()
  })

  it('rejects selected-app jobs before runtime discovery, settings access or SDK startup', async () => {
    const events = await collect(new CodexEngine().run({ prompt: 'Operate the selected app', workdir: WORKDIR, disallowTools: true, requireToolIsolation: true }))
    expect(events).toEqual([{ type: 'error', kind: 'crash', message: expect.stringContaining('cannot safely run selected-app tools') }])
    expect(fixture.binary).not.toHaveBeenCalled()
    expect(fixture.settings).not.toHaveBeenCalled()
    expect(fixture.options).not.toHaveBeenCalled()
    expect(fixture.run).not.toHaveBeenCalled()
  })

  it('retains the existing ordinary text job settings without promising desktop isolation', async () => {
    const events = await collect(new CodexEngine().run({ prompt: 'Read the provided text', workdir: WORKDIR, disallowTools: true, jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } } }))
    expect(events).toEqual([{ type: 'result', text: 'fixture answer' }])
    expect(new CodexEngine().desktopToolIsolation).toBe(false)
    expect(fixture.options).toHaveBeenCalledWith({ codexPathOverride: 'fixture-codex', env: { PATH: 'fixture-runtime-path' }, configOverrides: ['mcp_servers={"fixture"={command="node",enabled=false}}'] })
    expect(fixture.threadOptions).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false, model: 'chosen-model' }))
    expect(fixture.run).toHaveBeenCalledWith('Read the provided text', expect.objectContaining({ outputSchema: { type: 'object', properties: { answer: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['answer'], additionalProperties: false }, signal: expect.any(AbortSignal) }))
  })

  it('does not start the SDK when inherited connection discovery fails', async () => {
    fixture.catalog.mockResolvedValue({ code: null, out: '' })
    const events = await collect(new CodexEngine().run({ prompt: 'Read', workdir: WORKDIR, disallowTools: true }))
    expect(events).toEqual([{ type: 'error', kind: 'unknown', message: expect.stringContaining('Could not read the ChatGPT tool configuration') }])
    expect(fixture.run).not.toHaveBeenCalled()
  })

  it('restores optional fields before returning structured output to the tool loop', async () => {
    fixture.run.mockResolvedValue({ finalResponse: '{"answer":"verified","limit":null,"explicit":null}' })
    const events = await collect(new CodexEngine().run({ prompt: 'Read the provided text', workdir: WORKDIR, jsonSchema: {
      type: 'object', properties: { answer: { type: 'string' }, limit: { type: 'integer' }, explicit: { type: ['string', 'null'] } }, required: ['answer'],
    } }))
    expect(events).toEqual([{ type: 'result', text: '{"answer":"verified","explicit":null}' }])
  })
})
