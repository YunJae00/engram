import { describe, expect, it, vi } from 'vitest'
import type { EngineCwd, NativeTools, ToolSessionJob } from 'core'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const timingLog = vi.hoisted(() => vi.fn())
vi.mock('../src/main/flog.js', () => ({ flog: timingLog }))
import { SessionPool, type SdkUserMessage, type SessionSdk } from '../src/main/engine-claude-session.js'

// A stand-in runtime: one process per query, answering every user message
// it is fed with a call to the first tool and then an answer that names
// what the tool said. Counts how many processes were started.
function fakeSdk(log: string[], compact = false) {
  let processes = 0
  let interruptions = 0
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
          if (compact) yield { type: 'system', subtype: 'compact_boundary' }
          yield { type: 'assistant', message: { content: [{ type: 'text', text: `the tool said ${said.content[0]!.text}` }] } }
          yield { type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', result: `the tool said ${said.content[0]!.text}` }
        }
      }
      const stream = run() as AsyncGenerator<{ type: string }> & { interrupt(): Promise<unknown> }
      stream.interrupt = async () => {
        interruptions++
        interrupted = true
      }
      return stream
    },
  }
  return { sdk, processes: () => processes, interruptions: () => interruptions, optionsSeen, outcomes }
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
  it('keeps account sessions separate and closes every account copy of a conversation', async () => {
    const { sdk, processes, optionsSeen } = fakeSdk([])
    const pool = new SessionPool(), base = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'fixture' }
    try {
      await pool.run(job('Personal', { sessionKey: 'system:chat' }), { ...base, env: { CLAUDE_CONFIG_DIR: 'personal' } })
      await pool.run(job('Work', { sessionKey: 'work:chat' }), { ...base, env: { CLAUDE_CONFIG_DIR: 'work' } })
      expect(processes()).toBe(2)
      expect(optionsSeen.map(options => options['env'])).toEqual([{ CLAUDE_CONFIG_DIR: 'personal' }, { CLAUDE_CONFIG_DIR: 'work' }])
      pool.closeMatching('chat')
      await pool.run(job('New personal', { sessionKey: 'system:chat' }), base)
      await pool.run(job('New work', { sessionKey: 'work:chat' }), base)
      expect(processes()).toBe(4)
    } finally { pool.closeAll() }
  })
  it('invalidates observation deltas when runtime context is compacted', async () => {
    const { sdk } = fakeSdk([], true)
    const pool = new SessionPool(), onContextReset = vi.fn()
    try {
      await pool.run(job('Read', { onContextReset }), { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'fixture' })
      expect(onContextReset).toHaveBeenCalledTimes(1)
    } finally { pool.closeAll() }
  })
  it('recycles only the conversation whose reasoning effort changed', async () => {
    const { sdk, processes, optionsSeen } = fakeSdk([])
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'fixture' }
    try {
      await pool.run(job('First', { sessionKey: 'a', effort: 'low' }), spec)
      await pool.run(job('Second', { sessionKey: 'b', effort: 'high' }), spec)
      await pool.run(job('Change', { sessionKey: 'a', effort: 'medium' }), spec)
      await pool.run(job('Keep', { sessionKey: 'b', effort: 'high' }), spec)
      expect(processes()).toBe(3)
      expect(optionsSeen.map(options => options['effort'])).toEqual(['low', 'high', 'medium'])
    } finally { pool.closeAll() }
  })
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
        tools: ['ToolSearch'], strictMcpConfig: true, settingSources: [], permissionMode: 'dontAsk',
        allowedTools: ['ToolSearch', 'mcp__engram__look_desktop', 'mcp__engram__read_desktop', 'mcp__engram__desktop_action'],
      })
      expect(Object.keys(optionsSeen[0]!['mcpServers'] as object)).toEqual(['engram'])
      expect(outcomes[0]).toEqual({ content: [
        { type: 'text', text: 'snapshot: lane-a' },
        { type: 'image', data: 'fixture-image', mimeType: 'image/png' },
      ] })
      await pool.run(job('Inspect A without input', { sessionKey: 'lane-a', tools: tools.filter((tool) => tool.name === 'read_desktop') }), spec)
      expect(processes()).toBe(2)
      expect(optionsSeen[1]!['allowedTools']).toEqual(['ToolSearch', 'mcp__engram__read_desktop'])
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
    const { sdk, processes, interruptions, optionsSeen } = fakeSdk([])
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
    expect(interruptions()).toBe(1)
    expect((optionsSeen[0]!['abortController'] as AbortController).signal.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    const next = await pool.run(job('again', { sessionKey: 'k' }), spec)
    expect(next.answer).toContain('again')
    expect(processes()).toBe(2)
    pool.closeAll()
  })

  it('removes a finished turn signal so its later abort cannot cancel a warm follow-up', async () => {
    const { sdk, processes, interruptions, optionsSeen } = fakeSdk([])
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    const previous = new AbortController()
    const add = vi.spyOn(previous.signal, 'addEventListener')
    const remove = vi.spyOn(previous.signal, 'removeEventListener')
    try {
      await pool.run(job('first', { sessionKey: 'k', signal: previous.signal }), spec)
      const listener = add.mock.calls.find(([type]) => type === 'abort')![1]
      const next = await pool.run(job('second', {
        sessionKey: 'k', tools: [{ name: 'search_memory', description: 'search', argsSchema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => {
          previous.abort()
          if (typeof listener === 'function') listener.call(previous.signal, new Event('abort'))
          return 'the second turn completed'
        } }],
      }), spec)
      expect(next).toEqual({ answer: 'the tool said the second turn completed' })
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(interruptions()).toBe(0)
      expect(processes()).toBe(1)
      expect((optionsSeen[0]!['abortController'] as AbortController).signal.aborted).toBe(false)
    } finally { pool.closeAll() }
  })

  it('does not open or queue an already-aborted job', async () => {
    const log: string[] = []
    const { sdk, processes } = fakeSdk(log)
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    const canceled = new AbortController()
    canceled.abort()
    try {
      expect(await pool.run(job('never queue', { signal: canceled.signal }), spec)).toEqual({ answer: '', error: 'canceled' })
      expect(processes()).toBe(0)
      expect(log).toEqual([])
    } finally { pool.closeAll() }
  })

  it('does not let an already-aborted job replace the current active session', async () => {
    const log: string[] = []
    const { sdk, processes, interruptions } = fakeSdk(log)
    const pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'sonnet' }
    const canceled = new AbortController()
    canceled.abort()
    try {
      const current = await pool.run(job('active', {
        tools: [{ name: 'search_memory', description: 'search', argsSchema: {}, run: async () => {
          expect(await pool.run(job('never replace', { signal: canceled.signal }), spec)).toEqual({ answer: '', error: 'canceled' })
          return 'still active'
        } }],
      }), spec)
      expect(current).toEqual({ answer: 'the tool said still active' })
      expect(processes()).toBe(1)
      expect(interruptions()).toBe(0)
      expect(log).toEqual(['user: active'])
    } finally { pool.closeAll() }
  })
})

export type { SdkUserMessage }

// A runtime that writes its reply a few words at a time: thinking aloud,
// then a tool call, then the answer - the pieces a person watches arrive.
function streamingSdk(beforeReply?: () => AsyncIterable<{ type: string; [key: string]: unknown }>): SessionSdk {
  return {
    createSdkMcpServer: (options) => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt, options }) => {
      const partial = options?.['includePartialMessages'] === true
      async function* run(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        for await (const message of prompt) {
          void message
          if (partial) {
            if (beforeReply) yield* beforeReply()
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
  it('reports useful hidden progress without exposing content or accepting empty events and pings', async () => {
    const pool = new SessionPool(), onProgress = vi.fn(), onToken = vi.fn()
    timingLog.mockClear()
    async function* events() {
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private reasoning fixture' } } }
      yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'private arguments fixture' } } }
      yield { type: 'system', subtype: 'thinking_tokens', estimated_tokens_delta: 3 }
      for (const value of ['', undefined, 42]) {
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: value } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: value } } }
      }
      for (const value of [0, -1, NaN, Infinity, '3', undefined]) yield { type: 'system', subtype: 'thinking_tokens', estimated_tokens_delta: value }
      yield { type: 'stream_event', event: { type: 'ping' } }
      yield { type: 'system', subtype: 'keep_alive', estimated_tokens_delta: 3 }
    }
    try {
      const result = await pool.run(job('Task', { onProgress, onToken }), { sdk: streamingSdk(events), binary: 'claude', workdir: 'C:/tmp', model: 'fixture' })
      expect(onProgress.mock.calls).toEqual([[], [], []])
      expect(onToken.mock.calls.flat()).toEqual(['Let me look. ', 'The ', 'answer ', 'is 42.'])
      expect(result).toEqual({ answer: 'The answer is 42.' })
      expect(JSON.stringify([result, onProgress.mock.calls, onToken.mock.calls, timingLog.mock.calls])).not.toContain('private')
    } finally { pool.closeAll() }
  })

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

describe('a spare session for the next comet', () => {
  it('reserves explicitly warmed folders and refuses sharing across comets, workspaces and accounts', async () => {
    const { sdk, processes, optionsSeen } = fakeSdk([])
    const pool = new SessionPool(), base = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'fixture' }
    const work = join(tmpdir(), 'engram-spare-fixture')
    const hands = (cwd: string): NativeTools => ({ cwd, readRoots: [cwd], decide: async () => ({ behavior: 'allow' }) })
    try {
      await pool.run(job('First', { sessionKey: 'a', native: hands(join(work, 'bot-a')) }), base)
      expect(processes()).toBe(1)
      pool.warm(base, job('', { native: hands(join(work, 'spare-1')) }))
      expect(processes()).toBe(2)
      const folder = pool.claimWorkFolder('bot-b', join(work, 'bot-b'))
      expect(folder.startsWith(join(work, 'spare-'))).toBe(true)
      expect(pool.claimWorkFolder('bot-b', join(work, 'bot-b'))).toBe(folder)
      expect(pool.claimWorkFolder('bot-c', join(work, 'bot-c'))).toBe(join(work, 'bot-c'))
      expect(pool.claimWorkFolder('bot-d', join(work, 'other-vault', 'bot-d'))).toBe(join(work, 'other-vault', 'bot-d'))
      await pool.run(job('Second', { sessionKey: 'b', native: hands(folder) }), base)
      expect(processes()).toBe(2)
      pool.warm(base, job('', { native: hands(join(work, 'spare-2')) }))
      expect(optionsSeen[1]!['cwd']).toBe(folder)
      expect(pool.claimWorkFolder('bot-c', join(work, 'bot-c'))).not.toBe(folder)
      expect(pool.claimWorkFolder('bot-c', join(work, 'bot-c')).startsWith(join(work, 'spare-'))).toBe(true)
      const next = pool.claimWorkFolder('bot-c', join(work, 'bot-c'))
      await pool.run(job('Another account', { sessionKey: 'c', native: hands(next) }), { ...base, env: { CLAUDE_CONFIG_DIR: 'another-profile' } })
      expect(processes()).toBe(4)
      expect(optionsSeen[3]!['env']).toEqual({ CLAUDE_CONFIG_DIR: 'another-profile' })
      expect(pool.spareReady).toBe(false)
    } finally { pool.closeAll() }
  })
})

describe('a spare opened before any comet', () => {
  it('is taken by the first comet without creating a second preparation path', async () => {
    const { sdk, processes, optionsSeen } = fakeSdk([])
    const pool = new SessionPool(), base = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'fixture' }
    const work = join(tmpdir(), 'engram-spare-fixture')
    const hands = (cwd: string): NativeTools => ({ cwd, readRoots: [cwd], decide: async () => ({ behavior: 'allow' }) })
    try {
      pool.warm(base, job('', { native: hands(join(work, 'spare-0')) }))
      expect(processes()).toBe(1)
      expect(pool.spareReady).toBe(true)
      const folder = pool.claimWorkFolder('bot-a', join(work, 'bot-a'))
      expect(folder).toBe(join(work, 'spare-0'))
      await pool.run(job('First', { sessionKey: 'a', native: hands(folder) }), base)
      expect(optionsSeen[0]!['cwd']).toBe(folder)
      expect(processes()).toBe(1)
      expect(pool.spareReady).toBe(false)
    } finally { pool.closeAll() }
  })

  it('replaces an expired spare instead of leaving preparation permanently blocked', () => {
    const { sdk, processes } = fakeSdk([]), pool = new SessionPool()
    const spec = { sdk, binary: 'claude', workdir: 'C:/tmp', model: 'fixture' }
    const hands = { cwd: 'C:/work/spare-old', readRoots: [], decide: async () => ({ behavior: 'allow' as const }) }
    try {
      pool.warm(spec, job('', { native: hands }))
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 60_000)
      expect(pool.spareReady).toBe(false)
      pool.warm(spec, job('', { native: { ...hands, cwd: 'C:/work/spare-new' } }))
      expect(processes()).toBe(2)
      expect(pool.claimWorkFolder('next', 'C:/work/next')).toBe('C:/work/spare-new')
    } finally { pool.closeAll(); vi.restoreAllMocks() }
  })
})
