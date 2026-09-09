import { describe, expect, it, vi } from 'vitest'
import type { EngineCwd, ToolSessionJob } from 'core'
const timingLog = vi.hoisted(() => vi.fn())
vi.mock('../src/main/flog.js', () => ({ flog: timingLog }))
import { SessionPool, type SdkUserMessage, type SessionSdk } from '../src/main/engine-claude-session.js'

// A stand-in runtime: one process per query, answering every user message
// it is fed with a call to the first tool and then an answer that names
// what the tool said. Counts how many processes were started.
function fakeSdk(log: string[]) {
  let processes = 0
  const optionsSeen: Record<string, unknown>[] = []
  const outcomes: unknown[] = []
  const sdk: SessionSdk = {
    createSdkMcpServer: (options) => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt, options }) => {
      processes++
      optionsSeen.push(options ?? {})
      const server = (options?.['mcpServers'] as Record<string, { tools: { name: string; handler(args: unknown): Promise<{ content: { text: string }[] }> }[] }>)['engram']!
      let interrupted = false
      async function* run(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        for await (const message of prompt) {
          log.push(`user: ${message.message.content}`)
          const first = server.tools[0]!
          const said = await first.handler({ query: message.message.content })
          outcomes.push(said)
          yield { type: 'assistant', message: { content: [{ type: 'text', text: `the tool said ${said.content[0]!.text}` }] } }
          yield { type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', result: `the tool said ${said.content[0]!.text}` }
        }
      }
      const stream = run() as AsyncGenerator<{ type: string }> & { interrupt(): Promise<unknown> }
      stream.interrupt = async () => {
        interrupted = true
      }
      return stream
    },
  }
  return { sdk, processes: () => processes, optionsSeen, outcomes }
}

function job(prompt: string, extra: Partial<ToolSessionJob> = {}): ToolSessionJob {
  return {
    workdir: 'C:/tmp' as EngineCwd,
    system: 'rules',
    prompt,
    tools: [{ name: 'search_memory', description: 'search', argsSchema: { type: 'object', properties: { query: { type: 'string' } } }, run: async (args) => `notes on ${String(args['query'])}` }],
    maxCalls: 12,
    ...extra,
  }
}

describe('a warm session: one process, many turns', () => {
  it('records tool duration and between-tool wait without task content', async () => {
    timingLog.mockClear()
    const { sdk } = fakeSdk([])
    const pool = new SessionPool()
    try {
      await pool.run(job('private fixture content', { sessionKey: 'timing' }), { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' })
      const entries = timingLog.mock.calls.filter(([tag]) => tag === 'engine-tool-latency')
      expect(entries).toHaveLength(1)
      expect(entries[0]![1]).toMatch(/^tool=search_memory between_tools_ms=\d+ tool_ms=\d+$/)
      expect(JSON.stringify(entries)).not.toContain('private fixture content')
    } finally { pool.closeAll() }
  })
  it('isolates supplied desktop tools and rich observations, recycling when access is removed', async () => {
    const { sdk, processes, optionsSeen, outcomes } = fakeSdk([])
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    const tools: ToolSessionJob['tools'] = [
      { name: 'look_desktop', description: 'Look at selected app', argsSchema: {}, run: async () => ({ text: 'snapshot: lane-a', image: { data: 'fixture-image', mimeType: 'image/png' } }) },
      { name: 'read_desktop', description: 'Read selected app', argsSchema: {}, run: async () => 'selected text' },
      { name: 'desktop_action', description: 'Act in selected app', argsSchema: {}, run: async () => 'selected action' },
    ]
    try {
      await pool.run(job('Inspect A', { sessionKey: 'lane-a', tools }), spec)
      expect(optionsSeen[0]).toMatchObject({
        tools: [], strictMcpConfig: true, settingSources: [], permissionMode: 'dontAsk',
        allowedTools: ['mcp__engram__look_desktop', 'mcp__engram__read_desktop', 'mcp__engram__desktop_action'],
      })
      expect(Object.keys(optionsSeen[0]!['mcpServers'] as object)).toEqual(['engram'])
      expect(outcomes[0]).toEqual({ content: [
        { type: 'text', text: 'snapshot: lane-a' },
        { type: 'image', data: 'fixture-image', mimeType: 'image/png' },
      ] })
      await pool.run(job('Inspect A without input', { sessionKey: 'lane-a', tools: tools.filter((tool) => tool.name === 'read_desktop') }), spec)
      expect(processes()).toBe(2)
      expect(optionsSeen[1]!['allowedTools']).toEqual(['mcp__engram__read_desktop'])
      expect(optionsSeen[1]!['strictMcpConfig']).toBe(true)
    } finally { pool.closeAll() }
  })

  it('two turns under one key share a process, and the conversation opens only the first', async () => {
    const log: string[] = []
    const { sdk, processes } = fakeSdk(log)
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    const first = await pool.run(job('Task: deploys', { sessionKey: 'bot-1', opening: 'User: hi\nYou: hello' }), spec)
    const second = await pool.run(job('Task: pricing', { sessionKey: 'bot-1', opening: 'User: hi\nYou: hello' }), spec)
    expect(first.answer).toBe('the tool said notes on User: hi\nYou: hello\n\nTask: deploys')
    expect(second.answer).toBe('the tool said notes on Task: pricing')
    expect(processes()).toBe(1)
    expect(log).toEqual(['user: User: hi\nYou: hello\n\nTask: deploys', 'user: Task: pricing'])
    pool.closeAll()
  })

  it('a different key, or different standing rules, is a different process', async () => {
    const { sdk, processes } = fakeSdk([])
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    await pool.run(job('a', { sessionKey: 'bot-1' }), spec)
    await pool.run(job('b', { sessionKey: 'bot-2' }), spec)
    await pool.run(job('c', { sessionKey: 'bot-1', system: 'other rules' }), spec)
    expect(processes()).toBe(3)
    pool.closeAll()
  })

  it('the tools of the turn under way answer, not the ones the session opened with', async () => {
    const { sdk } = fakeSdk([])
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    await pool.run(job('a', { sessionKey: 'k' }), spec)
    const later = await pool.run(
      job('b', {
        sessionKey: 'k',
        tools: [{ name: 'search_memory', description: 'search', argsSchema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => 'a newer notebook' }],
      }),
      spec,
    )
    expect(later.answer).toBe('the tool said a newer notebook')
    pool.closeAll()
  })

  it('a cancelled turn comes back as canceled and the pool opens a fresh session next time', async () => {
    const { sdk, processes } = fakeSdk([])
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    const abort = new AbortController()
    const slow: ToolSessionJob = job('slow', {
      sessionKey: 'k',
      signal: abort.signal,
      tools: [{ name: 'search_memory', description: 'search', argsSchema: {}, run: () => new Promise((resolve) => setTimeout(() => resolve('late'), 200)) }],
    })
    const pending = pool.run(slow, spec)
    abort.abort()
    expect((await pending).error).toBe('canceled')
    await new Promise((resolve) => setTimeout(resolve, 250))
    const next = await pool.run(job('again', { sessionKey: 'k' }), spec)
    expect(next.answer).toContain('again')
    expect(processes()).toBe(2)
    pool.closeAll()
  })
})

export type { SdkUserMessage }

// A runtime that writes its reply a few words at a time: thinking aloud,
// then a tool call, then the answer - the pieces a person watches arrive.
function streamingSdk(): SessionSdk {
  return {
    createSdkMcpServer: (options) => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt, options }) => {
      const partial = options?.['includePartialMessages'] === true
      async function* run(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        for await (const message of prompt) {
          void message
          if (partial) {
            yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me look. ' } } }
            yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } }
            for (const word of ['The ', 'answer ', 'is 42.']) yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: word } } }
          }
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'The answer is 42.' }] } }
          yield { type: 'result', subtype: 'success', result: 'The answer is 42.' }
        }
      }
      const stream = run() as AsyncGenerator<{ type: string }> & { interrupt(): Promise<unknown> }
      stream.interrupt = async () => undefined
      return stream
    },
  }
}

describe('the reply streams as it is written', () => {
  it('hands each piece over as it comes, and starts over after a tool call', async () => {
    const pool = new SessionPool()
    const spec = { sdk: streamingSdk(), binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    const pieces: string[] = []
    let resets = 0
    const result = await pool.run(job('Task: anything', { sessionKey: 'k', onToken: (text) => pieces.push(text), onReset: () => resets++ }), spec)
    expect(result.answer).toBe('The answer is 42.')
    expect(pieces).toEqual(['Let me look. ', 'The ', 'answer ', 'is 42.'])
    expect(resets).toBe(1)
    pool.closeAll()
  })
})
