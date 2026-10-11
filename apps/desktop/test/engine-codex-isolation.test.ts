import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineCwd, EngineEvent } from 'core'
import { SESSION_TURN_MS } from 'core'

const fixture = vi.hoisted(() => ({
  ready: vi.fn(), options: vi.fn(), threadOptions: vi.fn(), run: vi.fn(), binary: vi.fn(), settings: vi.fn(), query: vi.fn(), catalog: vi.fn(), native: vi.fn(),
}))
vi.mock('../src/main/codex-native.js', () => ({ appServer: () => 'fixture-rpc', runCodexNative: fixture.native }))
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
import { CodexEngine, RUNTIME_TOOLS_OFF, disableMcpOverrides } from '../src/main/engine-codex.js'
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

  it('isolates selected-app plain-text decisions without exposing inherited tools', async () => {
    const events = await collect(new CodexEngine().run({ prompt: 'Operate the selected app', workdir: WORKDIR, disallowTools: true, requireToolIsolation: true }))
    expect(events).toEqual([{ type: 'result', text: 'fixture answer' }])
    expect(fixture.options.mock.lastCall![0].configOverrides).toEqual(['mcp_servers={"fixture"={command="node",enabled=false}}', ...RUNTIME_TOOLS_OFF])
    expect(fixture.catalog).toHaveBeenCalledWith('fixture-codex', ['-C', WORKDIR, 'mcp', 'list', '--json'], expect.any(Number), expect.any(Object), expect.any(Object))
  })

  it('keeps ordinary text jobs read-only with the runtime tools off', async () => {
    const events = await collect(new CodexEngine().run({ prompt: 'Read the provided text', workdir: WORKDIR, disallowTools: true, jsonSchema: { type: 'object', properties: { answer: { type: 'string' } } } }))
    expect(events).toEqual([{ type: 'result', text: 'fixture answer' }])
    expect(fixture.options).toHaveBeenCalledWith({ codexPathOverride: 'fixture-codex', env: { PATH: 'fixture-runtime-path' }, configOverrides: ['mcp_servers={"fixture"={command="node",enabled=false}}', ...RUNTIME_TOOLS_OFF] })
    expect(RUNTIME_TOOLS_OFF).toEqual(expect.arrayContaining(['features.shell_tool=false', 'features.unified_exec=false', 'features.apps=false', 'features.plugins=false', 'features.computer_use=false']))
    // Current models call every tool through the code-mode host; switching it off leaves a tool session with no tools.
    expect(RUNTIME_TOOLS_OFF).not.toContain('features.code_mode_host=false')
    expect(fixture.threadOptions).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false, model: 'chosen-model' }))
    expect(fixture.run).toHaveBeenCalledWith('Read the provided text', expect.objectContaining({ outputSchema: { type: 'object', properties: { answer: { anyOf: [{ type: 'string' }, { type: 'null' }] } }, required: ['answer'], additionalProperties: false }, signal: expect.any(AbortSignal) }))
  })

  it('runs a tool session with only the comet tools, reachable through an authenticated loopback server', async () => {
    const seen: Record<string, unknown>[] = []
    let served = ''
    fixture.run.mockImplementationOnce(async (input: string) => {
      const options = fixture.options.mock.lastCall![0] as { env: Record<string, string>; configOverrides: string[] }
      const url = /engram_comet=\{url="([^"]+)"/.exec(options.configOverrides[0]!)![1]!
      const call = (auth: string) => fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'note_read', arguments: { id: 'n1' } } }) })
      expect((await call('Bearer wrong')).status).toBe(401)
      served = JSON.stringify(await (await call('Bearer ' + options.env['ENGRAM_COMET_TOOL_TOKEN'])).json())
      return { finalResponse: 'answer from ' + input.split('\n\n').length + ' parts' }
    })
    const tokens: string[] = []
    const result = await new CodexEngine().runTools({ workdir: WORKDIR, system: 'Rules', opening: 'Earlier', prompt: 'Do it', maxCalls: 5, onToken: text => tokens.push(text),
      tools: [{ name: 'note_read', description: 'Read a note', argsSchema: { properties: { id: { type: 'string' } } }, run: async args => { seen.push(args); return 'note body' } }] })
    expect(result).toEqual({ answer: 'answer from 4 parts' })
    expect(tokens).toEqual(['answer from 4 parts'])
    expect(seen).toEqual([{ id: 'n1' }])
    expect(served).toContain('note body')
    const options = fixture.options.mock.lastCall![0] as { configOverrides: string[] }
    expect(options.configOverrides[0]).toMatch(/^mcp_servers=\{"fixture"=\{command="node",enabled=false\},engram_comet=\{url="http:\/\/127\.0\.0\.1:\d+\/mcp",bearer_token_env_var="ENGRAM_COMET_TOOL_TOKEN",tool_timeout_sec=900,default_tools_approval_mode="approve"\}\}$/)
    expect(options.configOverrides.slice(1)).toEqual(RUNTIME_TOOLS_OFF)
    expect(fixture.threadOptions).toHaveBeenLastCalledWith(expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled', networkAccessEnabled: false }))
    expect(new CodexEngine().desktopToolIsolation).toBe(true)
  })

  it('does not start the SDK when inherited connection discovery fails', async () => {
    fixture.catalog.mockResolvedValue({ code: null, out: '' })
    const events = await collect(new CodexEngine().run({ prompt: 'Read', workdir: WORKDIR, disallowTools: true }))
    expect(events).toEqual([{ type: 'error', kind: 'unknown', message: expect.stringContaining('Could not read the ChatGPT tool configuration') }])
    expect(fixture.run).not.toHaveBeenCalled()
  })

  it('continues with isolated comet tools when native commands are declined', async () => {
    fixture.native.mockResolvedValueOnce({ answer: '', error: 'Declined', commandsDenied: true })
    const result = await new CodexEngine().runTools({ workdir: WORKDIR, system: 'Rules', prompt: 'Read a page', tools: [], maxCalls: 1,
      native: { cwd: 'C:/work/task', decide: async () => ({ behavior: 'deny' }) } })
    expect(result).toEqual({ answer: 'fixture answer' })
    expect(fixture.native).toHaveBeenCalledOnce()
    expect(fixture.options.mock.lastCall![0].configOverrides.slice(1)).toEqual(RUNTIME_TOOLS_OFF)
    expect(fixture.threadOptions).toHaveBeenLastCalledWith(expect.objectContaining({ sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false }))
  })

  it('does not replay native work after a runtime failure', async () => {
    fixture.native.mockResolvedValueOnce({ answer: 'Partial work', error: 'Runtime failed' })
    const result = await new CodexEngine().runTools({ workdir: WORKDIR, system: '', prompt: 'Do it', tools: [], maxCalls: 1,
      native: { cwd: 'C:/work/task', decide: async () => ({ behavior: 'allow' }) } })
    expect(result).toEqual({ answer: 'Partial work', error: 'Runtime failed' })
    expect(fixture.run).not.toHaveBeenCalled()
  })

  it('disables inherited MCP for ordinary jobs too and replaces a colliding local server name', async () => {
    await collect(new CodexEngine().run({ prompt: 'Read', workdir: WORKDIR }))
    expect(fixture.options.mock.lastCall![0].configOverrides[0]).toContain('enabled=false')
    expect(disableMcpOverrides('[{"name":"engram_comet","transport":{"command":"untrusted"}}]', { engram_comet: '{url="http://127.0.0.1:1234/mcp"}' }))
      .toEqual(['mcp_servers={engram_comet={url="http://127.0.0.1:1234/mcp"}}'])
  })

  it('does not start an already canceled tool session', async () => {
    const result = await new CodexEngine().runTools({ workdir: WORKDIR, system: '', prompt: 'Do it', tools: [], maxCalls: 1, signal: AbortSignal.abort() })
    expect(result.error).toBe('canceled')
    expect(fixture.binary).not.toHaveBeenCalled()
    expect(fixture.run).not.toHaveBeenCalled()
  })

  it('closes the tool endpoint after a runtime failure', async () => {
    let url = ''
    fixture.run.mockImplementationOnce(async () => {
      url = /url="([^"]+)"/.exec(fixture.options.mock.lastCall![0].configOverrides[0])![1]!
      throw new Error('fixture failure')
    })
    const result = await new CodexEngine().runTools({ workdir: WORKDIR, system: '', prompt: 'Do it', tools: [], maxCalls: 1 })
    expect(result.error).toBe('fixture failure')
    await expect(fetch(url)).rejects.toThrow()
  })

  it('bounds a silent tool turn and reports timeout rather than success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    fixture.run.mockImplementationOnce((_input: unknown, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      started()
    }))
    try {
      const pending = new CodexEngine().runTools({ workdir: WORKDIR, system: '', prompt: 'Do it', tools: [], maxCalls: 1 })
      await ready
      await vi.advanceTimersByTimeAsync(SESSION_TURN_MS)
      expect((await pending).error).toBe(`timed out after ${SESSION_TURN_MS}ms`)
    } finally { vi.useRealTimers() }
  })

  it('restores optional fields before returning structured output to the tool loop', async () => {
    fixture.run.mockResolvedValue({ finalResponse: '{"answer":"verified","limit":null,"explicit":null}' })
    const events = await collect(new CodexEngine().run({ prompt: 'Read the provided text', workdir: WORKDIR, jsonSchema: {
      type: 'object', properties: { answer: { type: 'string' }, limit: { type: 'integer' }, explicit: { type: ['string', 'null'] } }, required: ['answer'],
    } }))
    expect(events).toEqual([{ type: 'result', text: '{"answer":"verified","explicit":null}' }])
  })
})
