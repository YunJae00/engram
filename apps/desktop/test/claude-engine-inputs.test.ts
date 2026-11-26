import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineCwd, ToolSessionJob } from 'core'
import { ClaudeEngine, closeVoices, fetchClaudeModels, forgetClaudeModels, type ClaudeInputs } from '../src/main/engine-claude.js'
import { SessionPool } from '../src/main/engine-claude-session.js'
import { workerPool } from '../src/main/worker-pool.js'

vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))

interface Seen { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }

function world(binary: string | null = 'orchard-runtime', grower = 'picked') {
  const order: string[] = []
  const seen: Seen[] = []
  const said: string[][] = []
  const loop = {
    createSdkMcpServer: (options: unknown) => options,
    tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
    query: (params: Seen) => {
      seen.push(params)
      const heard: string[] = []
      said.push(heard)
      async function* run(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        yield { type: 'system', subtype: 'init', model: 'orchard-model' }
        for await (const message of params.prompt) {
          heard.push(message.message.content)
          yield { type: 'result', subtype: 'success', result: `${grower} ${heard.length}` }
        }
      }
      const stream = run() as AsyncGenerator<{ type: string }> & { interrupt(): Promise<unknown>; supportedModels(): Promise<unknown[]> }
      stream.interrupt = async () => undefined
      stream.supportedModels = async () => [{ value: grower, displayName: grower, description: `kept by ${grower}` }]
      return stream
    },
  }
  const sessions = new SessionPool()
  const inputs: ClaudeInputs = {
    binary: vi.fn(() => binary),
    sdk: vi.fn(async () => loop),
    env: vi.fn((profile: string) => { order.push('env'); return { ORCHARD_PROFILE: profile } }),
    loadConnections: vi.fn(async () => { order.push('connections') }),
    hasConnection: vi.fn(() => false),
    clearConnection: vi.fn(async () => undefined),
    probeConnection: vi.fn(async () => ({ ok: true, status: 200 })),
    logTools: vi.fn(),
    started: vi.fn(),
    afterFirstSession: vi.fn(async () => undefined),
    sessions,
  }
  return { inputs, order, seen, said, sessions }
}

const job = (extra: Partial<ToolSessionJob> = {}): ToolSessionJob => ({
  workdir: '/orchard' as EngineCwd,
  system: 'You keep the orchard harvest ledger.',
  opening: 'The pear trees are picked in late September.',
  prompt: 'How many crates of apples came in on Monday?',
  sessionKey: 'harvest',
  maxCalls: 3,
  tools: [{ name: 'crate_count', description: 'Counts crates for a day', argsSchema: { type: 'object', properties: { day: { type: 'string' } }, required: ['day'] }, run: async () => '42 crates' }],
  ...extra,
})

let open: SessionPool | undefined
afterEach(() => { open?.closeAll(); open = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('the Claude engine built from plain inputs', () => {
  it('hands the vendor loop the same tool server, model and session options as the app', async () => {
    vi.stubEnv('ENGRAM_CLAUDE_MODEL', '')
    const w = world(); open = w.sessions
    expect((await new ClaudeEngine(w.inputs, 'grove').runTools(job({ modelHint: 'smart', effort: 'medium' }))).answer).toBe('picked 1')
    const options = w.seen[0]!.options
    expect(options).toMatchObject({
      cwd: '/orchard', systemPrompt: 'You keep the orchard harvest ledger.', model: 'sonnet', effort: 'medium', maxTurns: 400,
      tools: ['ToolSearch'], permissionMode: 'dontAsk', allowedTools: ['ToolSearch', 'mcp__engram__crate_count'],
      strictMcpConfig: true, includePartialMessages: true, persistSession: false, settingSources: [],
    })
    const server = (options['mcpServers'] as Record<string, { name: string; alwaysLoad?: boolean; tools: { name: string; description: string }[] }>)['engram']!
    expect({ name: server.name, alwaysLoad: server.alwaysLoad, tools: server.tools.map(tool => [tool.name, tool.description]) }).toEqual({ name: 'engram', alwaysLoad: true, tools: [['crate_count', 'Counts crates for a day']] })
  })

  it('uses the given runtime, loader, account environment and tool log, reading the environment after the connections', async () => {
    const w = world(); open = w.sessions
    const asked = job()
    await new ClaudeEngine(w.inputs, 'grove').runTools(asked)
    const options = w.seen[0]!.options
    expect(options['pathToClaudeCodeExecutable']).toBe('orchard-runtime')
    expect(options['env']).toEqual({ ORCHARD_PROFILE: 'grove' })
    expect(w.inputs.sdk).toHaveBeenCalled()
    expect(w.inputs.logTools).toHaveBeenCalledWith(expect.objectContaining({ prompt: asked.prompt, system: asked.system }))
    expect(w.order.indexOf('connections')).toBeLessThan(w.order.indexOf('env'))
  })

  it('reuses the session for the same key and rules, sends the opening once, and opens a new one when the rules change', async () => {
    const w = world(); open = w.sessions
    const engine = new ClaudeEngine(w.inputs, 'grove')
    expect((await engine.runTools(job())).answer).toBe('picked 1')
    expect((await engine.runTools(job({ prompt: 'And the plums?' }))).answer).toBe('picked 2')
    expect(w.seen).toHaveLength(1)
    expect(w.said[0]).toEqual(['The pear trees are picked in late September.\n\nHow many crates of apples came in on Monday?', 'And the plums?'])
    await engine.runTools(job({ system: 'You keep the pruning calendar.', prompt: 'When do we prune the cherries?' }))
    expect(w.seen).toHaveLength(2)
    expect(w.said[1]).toEqual(['The pear trees are picked in late September.\n\nWhen do we prune the cherries?'])
  })

  it('signals the first session once when the runtime reports it started', async () => {
    const w = world(); open = w.sessions
    const engine = new ClaudeEngine(w.inputs, 'grove')
    await engine.runTools(job())
    await engine.runTools(job({ prompt: 'And the quinces?' }))
    expect(w.inputs.started).toHaveBeenCalledOnce()
  })

  it('says the runtime is missing without taking a worker', async () => {
    const w = world(null)
    const lease = vi.spyOn(workerPool, 'lease')
    expect(await new ClaudeEngine(w.inputs, 'grove').runTools(job())).toEqual({ answer: '', error: 'Install the Claude runtime in Settings → AI before connecting.' })
    expect(lease).not.toHaveBeenCalled()
    expect(w.seen).toHaveLength(0)
  })

  it('checks and clears a saved connection through the connection inputs', async () => {
    const w = world()
    vi.mocked(w.inputs.hasConnection).mockReturnValue(true)
    const engine = new ClaudeEngine(w.inputs, 'grove')
    expect(await engine.detect()).toEqual({ installed: true, loggedIn: true, conclusive: true })
    expect(w.inputs.probeConnection).toHaveBeenCalledWith('grove')
    await engine.logout()
    expect(w.inputs.clearConnection).toHaveBeenCalledWith('grove')
  })

  it('reports the runtime as missing on detect and sign-in when no binary is given', async () => {
    const w = world(null)
    const engine = new ClaudeEngine(w.inputs, 'grove')
    expect(await engine.detect()).toEqual({ installed: false, loggedIn: false, conclusive: true })
    expect(await engine.login()).toEqual({ ok: false, message: 'Install the Claude runtime in Settings → AI before connecting.' })
    expect(w.inputs.binary).toHaveBeenCalled()
    expect(w.inputs.loadConnections).not.toHaveBeenCalled()
  })

  it('keeps quick answers apart for two input sets that share a runtime path, profile and folder', async () => {
    const north = world('orchard-runtime', 'north'), south = world('orchard-runtime', 'south')
    try {
      expect(await new ClaudeEngine(north.inputs, 'grove').quick('Which row ripens first?', { workdir: '/orchard', timeoutMs: 5_000 })).toEqual({ text: 'north 1' })
      expect(await new ClaudeEngine(south.inputs, 'grove').quick('Which row ripens first?', { workdir: '/orchard', timeoutMs: 5_000 })).toEqual({ text: 'south 1' })
      expect(south.seen[0]!.options['env']).toEqual({ ORCHARD_PROFILE: 'grove' })
      expect(south.inputs.sdk).toHaveBeenCalled()
    } finally { closeVoices(north.inputs); closeVoices(south.inputs) }
  })

  it('lists models from each input set even when the profile is the same', async () => {
    const north = world('orchard-runtime', 'north'), south = world('orchard-runtime', 'south')
    try {
      expect((await fetchClaudeModels(north.inputs, 'grove')).map(row => row.value)).toEqual(['north'])
      expect((await fetchClaudeModels(south.inputs, 'grove')).map(row => row.value)).toEqual(['south'])
      expect(south.inputs.sdk).toHaveBeenCalledOnce()
      forgetClaudeModels(north.inputs)
      expect((await fetchClaudeModels(south.inputs, 'grove')).map(row => row.value)).toEqual(['south'])
      expect(south.inputs.sdk).toHaveBeenCalledOnce()
    } finally { forgetClaudeModels(north.inputs); forgetClaudeModels(south.inputs) }
  })
})
