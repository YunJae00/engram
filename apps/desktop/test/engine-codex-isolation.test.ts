import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineCwd, EngineEvent } from 'core'

const fixture = vi.hoisted(() => ({
  options: vi.fn(), threadOptions: vi.fn(), run: vi.fn(), binary: vi.fn(), settings: vi.fn(), query: vi.fn(),
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: fixture.query }))
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: unknown) { fixture.options(options) }
    startThread(options: unknown): { run: typeof fixture.run } {
      fixture.threadOptions(options)
      return { run: fixture.run }
    }
  },
}))
vi.mock('../src/main/engine-cloud.js', async (original) => ({
  ...await original<typeof import('../src/main/engine-cloud.js')>(),
  codexBinary: fixture.binary,
  claudeBinary: fixture.binary,
  withHelpersOnPath: () => ({ PATH: 'fixture-runtime-path' }),
}))
vi.mock('../src/main/settings.js', () => ({ loadSettings: fixture.settings }))
import { CodexEngine } from '../src/main/engine-codex.js'
import { ClaudeEngine } from '../src/main/engine-claude.js'

const WORKDIR = 'C:/tmp' as EngineCwd
async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const result: EngineEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  fixture.binary.mockReturnValue('fixture-codex')
  fixture.settings.mockResolvedValue({ codexModel: 'chosen-model', claudeModel: 'chosen-model' })
  fixture.run.mockResolvedValue({ finalResponse: 'fixture answer' })
  fixture.query.mockImplementation(async function* () { yield { type: 'result', subtype: 'success', result: 'fixture answer' } })
})

describe('text runtime desktop isolation boundary', () => {
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
    expect(fixture.options).toHaveBeenCalledWith({ codexPathOverride: 'fixture-codex', env: { PATH: 'fixture-runtime-path' } })
    expect(fixture.threadOptions).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false, model: 'chosen-model' }))
    expect(fixture.run).toHaveBeenCalledWith('Read the provided text', expect.objectContaining({ outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, additionalProperties: false }, signal: expect.any(AbortSignal) }))
  })
})
