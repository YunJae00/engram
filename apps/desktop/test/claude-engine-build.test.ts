import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineCwd, ToolSessionJob } from 'core'

const fixture = vi.hoisted(() => ({ query: vi.fn(), binary: vi.fn(() => 'kiln-claude' as string | null), said: [] as string[][] }))
vi.mock('electron', () => ({ app: { getPath: () => `${process.cwd()}/tmp/claude-engine-build-missing`, isPackaged: false }, net: {}, safeStorage: {} }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/account-profiles.js', () => ({ activeAccountProfile: () => 'kiln', accountEnvironment: () => ({ CLAUDE_CONFIG_DIR: 'kiln-config' }) }))
vi.mock('../src/main/brain-connections.js', () => ({ loadBrainConnections: async () => ({}), decisionConnectionState: () => ({ available: false }), hasBrainConnection: () => false, probeConnection: vi.fn(), clearBrainConnection: vi.fn(), connectionEnvironment: () => ({}) }))
vi.mock('../src/main/claude-runtime.js', () => ({ afterFirstClaudeSession: async () => undefined, claudeSessionStarted: () => {}, installedClaudeBinary: fixture.binary, loadClaudeSdk: async () => fakeLoop() }))

const { claudeEngine, closeClaudeSessions } = await import('../src/main/engine-cloud.js')
const { workerPool } = await import('../src/main/worker-pool.js')

interface Seen { prompt: AsyncIterable<{ message: { content: string } }>; options: Record<string, unknown> }

function fakeLoop() {
  return {
    createSdkMcpServer: (options: unknown) => options,
    tool: (name: string, description: string, shape: unknown, handler: unknown) => ({ name, description, shape, handler }),
    query: (params: Seen) => {
      fixture.query(params)
      const said: string[] = []
      fixture.said.push(said)
      async function* run(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        for await (const message of params.prompt) {
          said.push(message.message.content)
          yield { type: 'assistant', message: { content: [{ type: 'text', text: `fired ${said.length}` }] } }
          yield { type: 'result', subtype: 'success', result: `fired ${said.length}` }
        }
      }
      const stream = run() as AsyncGenerator<{ type: string }> & { interrupt(): Promise<unknown> }
      stream.interrupt = async () => undefined
      return stream
    },
  }
}

const job = (extra: Partial<ToolSessionJob> = {}): ToolSessionJob => ({
  workdir: '/pottery' as EngineCwd,
  system: 'You keep the kiln firing log.',
  opening: 'The studio fires stoneware on Thursdays.',
  prompt: 'Which shelf holds the celadon bowls?',
  sessionKey: 'kiln-log',
  maxCalls: 3,
  tools: [{ name: 'shelf_log', description: 'Reads the shelf log', argsSchema: { type: 'object', properties: { shelf: { type: 'string' } }, required: ['shelf'] }, run: async () => 'top shelf: celadon' }],
  ...extra,
})

beforeEach(() => { fixture.query.mockClear(); fixture.binary.mockClear(); fixture.binary.mockReturnValue('kiln-claude'); fixture.said = []; vi.stubEnv('ENGRAM_CLAUDE_MODEL', '') })
afterEach(() => { closeClaudeSessions(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('the Claude engine on the accepted base', () => {
  it('hands the vendor loop the tool server, model, effort and fixed session options', async () => {
    await claudeEngine('kiln').runTools(job({ modelHint: 'smart', effort: 'medium' }))
    const options = (fixture.query.mock.calls[0]![0] as Seen).options
    expect(options).toMatchObject({
      cwd: '/pottery', systemPrompt: 'You keep the kiln firing log.', model: 'sonnet', effort: 'medium', maxTurns: 400,
      tools: ['ToolSearch'], permissionMode: 'dontAsk', allowedTools: ['ToolSearch', 'mcp__engram__shelf_log'],
      strictMcpConfig: true, includePartialMessages: true, persistSession: false, settingSources: [],
    })
    const server = (options['mcpServers'] as Record<string, { name: string; alwaysLoad?: boolean; tools: { name: string; description: string }[] }>)['engram']!
    expect({ name: server.name, alwaysLoad: server.alwaysLoad, tools: server.tools.map(tool => [tool.name, tool.description]) }).toEqual({ name: 'engram', alwaysLoad: true, tools: [['shelf_log', 'Reads the shelf log']] })
  })

  it('keeps one session per key and rules, sends the opening once, and opens another when the rules change', async () => {
    const engine = claudeEngine('kiln')
    expect((await engine.runTools(job())).answer).toBe('fired 1')
    expect((await engine.runTools(job({ prompt: 'And the tenmoku jars?' }))).answer).toBe('fired 2')
    expect(fixture.query).toHaveBeenCalledOnce()
    expect(fixture.said[0]).toEqual(['The studio fires stoneware on Thursdays.\n\nWhich shelf holds the celadon bowls?', 'And the tenmoku jars?'])
    await engine.runTools(job({ system: 'You keep the glaze recipe book.', prompt: 'How much feldspar goes in?' }))
    expect(fixture.query).toHaveBeenCalledTimes(2)
    expect(fixture.said[1]).toEqual(['The studio fires stoneware on Thursdays.\n\nHow much feldspar goes in?'])
  })

  it('runs the installed runtime with the account environment under one worker lease', async () => {
    const lease = vi.spyOn(workerPool, 'lease')
    await claudeEngine('kiln').runTools(job())
    const options = (fixture.query.mock.calls[0]![0] as Seen).options
    expect(options['env']).toEqual({ CLAUDE_CONFIG_DIR: 'kiln-config' })
    expect(options['pathToClaudeCodeExecutable']).toBe('kiln-claude')
    expect(fixture.binary).toHaveBeenCalled()
    expect(lease).toHaveBeenCalledOnce()
  })

  it('says the runtime is missing without asking for a worker', async () => {
    fixture.binary.mockReturnValue(null)
    const lease = vi.spyOn(workerPool, 'lease')
    expect((await claudeEngine('kiln').runTools(job())).error).toBeTruthy()
    expect(lease).not.toHaveBeenCalled()
    expect(fixture.query).not.toHaveBeenCalled()
  })
})
