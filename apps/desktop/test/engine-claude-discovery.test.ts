import { expect, it, vi } from 'vitest'
import type { EngineCwd, NativeTools, ToolSessionJob } from 'core'
import { resolve } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => resolve('tmp/discovery-fixture') } }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { SessionPool, type SessionSdk } from '../src/main/engine-claude-session.js'
import { nativeDecision } from '../src/main/native-tools.js'

it.each([false, true])('discovers app tools in a spare and reused session with native commands %s', async nativeEnabled => {
  let processes = 0, searches = 0, reads = 0
  const cwd = resolve('tmp/discovery-fixture/spare-one')
  const decide = vi.fn<NativeTools['decide']>((name, input, signal) => nativeDecision({ cwd, roots: [cwd], privateDir: resolve('tmp/discovery-fixture/private'), commands: { allowed: false } }, name, input, signal))
  const native: NativeTools = { cwd, readRoots: [cwd], decide }
  const sdk: SessionSdk = {
    createSdkMcpServer: options => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt, options = {} }) => {
      processes++
      expect(options['strictMcpConfig']).toBe(true)
      expect(options['settingSources']).toEqual([])
      if (!nativeEnabled) expect(options['tools']).toEqual(['ToolSearch'])
      const server = (options['mcpServers'] as Record<string, { tools: { handler(args: unknown): Promise<unknown> }[] }>)['engram']!
      const signal = (options['abortController'] as AbortController).signal
      async function* run() {
        for await (const message of prompt) {
          expect(options['allowedTools']).toEqual(['ToolSearch', 'mcp__engram__list_windows'])
          if (nativeEnabled) {
            const id = `discovery-${++searches}`, input = { query: 'select:mcp__engram__list_windows' }
            const canUse = options['canUseTool'] as (name: string, args: unknown, context: { signal: AbortSignal; toolUseID: string }) => Promise<{ behavior: string }>
            const hooks = options['hooks'] as { PreToolUse: { hooks: ((input: object, id: string, context: { signal: AbortSignal }) => Promise<{ hookSpecificOutput: { permissionDecision: string } }>)[] }[] }
            expect((await canUse('ToolSearch', input, { signal, toolUseID: id })).behavior).toBe('allow')
            expect((await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: 'ToolSearch', tool_input: input, tool_use_id: id }, id, { signal })).hookSpecificOutput.permissionDecision).toBe('allow')
          } else searches++
          expect(message.message.content).toContain('app')
          const result = await server.tools[0]!.handler({})
          yield { type: 'result', subtype: 'success', result: JSON.stringify(result) }
        }
      }
      return Object.assign(run(), { interrupt: async () => undefined, supportedModels: async () => [] })
    },
  }
  const pool = new SessionPool(), spec = { sdk, binary: 'fixture', workdir: cwd, model: 'fixture' }
  const job = (prompt: string): ToolSessionJob => ({
    workdir: cwd as EngineCwd, system: 'Use the offered app tools.', prompt, sessionKey: 'app-chat', maxCalls: 4,
    tools: [{ name: 'list_windows', description: 'List open apps', argsSchema: { type: 'object', properties: {} }, run: async () => `App observation ${++reads}` }],
    ...(nativeEnabled ? { native } : {}),
  })
  try {
    pool.warm(spec, job(''))
    expect((await pool.run(job('Inspect the app'), spec)).answer).toContain('App observation 1')
    expect((await pool.run(job('Inspect the app again'), spec)).answer).toContain('App observation 2')
    expect(processes).toBe(1)
    expect(searches).toBe(2)
    if (nativeEnabled) {
      expect(decide).toHaveBeenCalledTimes(2)
      expect((await native.decide('Bash', { command: 'git log' }, new AbortController().signal)).behavior).toBe('deny')
    }
  } finally { pool.closeAll() }
})
