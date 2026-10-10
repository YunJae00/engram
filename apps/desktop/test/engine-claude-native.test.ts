import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeDecision, NativeTools } from 'core'
const log = vi.hoisted(() => vi.fn())
vi.mock('../src/main/flog.js', () => ({ flog: log }))
import { nativeOptions } from '../src/main/engine-claude-native.js'

const context = (toolUseID: string, signal = new AbortController().signal) => ({ toolUseID, signal })
const native = (decide: NativeTools['decide'] = async () => ({ behavior: 'allow' })): NativeTools => ({ cwd: 'work', readRoots: ['work'], decide, onCall: vi.fn(), onResult: vi.fn() })
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('native runtime permission hooks', () => {
  it('decides once per call ID across both SDK permission paths, not once per input', async () => {
    const decide = vi.fn(async (): Promise<NativeDecision> => ({ behavior: 'allow' }))
    const host = native(decide), options = nativeOptions(() => host), input = { file_path: 'note.txt' }
    const pre = options.hooks.PreToolUse[0]!.hooks[0]!
    const hook = await pre({ tool_name: 'Read', tool_input: input, tool_use_id: 'a' }, 'a', context('a'))
    expect(hook.hookSpecificOutput.permissionDecision).toBe('allow')
    expect((await options.canUseTool('Read', input, context('a'))).behavior).toBe('allow')
    expect(decide).toHaveBeenCalledTimes(1)
    await options.canUseTool('Read', input, context('b'))
    expect(decide).toHaveBeenCalledTimes(2)
    expect(host.onCall).toHaveBeenCalledTimes(2)
    expect((await options.canUseTool('Read', { file_path: 'other.txt' }, context('a'))).behavior).toBe('deny')
  })

  it('does not reuse an allowed decision in another turn or after the turn ends', async () => {
    let current: NativeTools | undefined = native()
    const options = nativeOptions(() => current)
    expect((await options.canUseTool('Write', {}, context('a'))).behavior).toBe('allow')
    current = native(async () => ({ behavior: 'deny', message: 'Read only.' }))
    expect((await options.canUseTool('Write', {}, context('a'))).behavior).toBe('deny')
    current = undefined
    expect((await options.canUseTool('Write', {}, context('a'))).behavior).toBe('deny')
  })

  it('turns rejected checks into denials and logs them without an unhandled rejection', async () => {
    const host = native(async () => { throw new Error('approval store unavailable') })
    const options = nativeOptions(() => host)
    expect((await options.canUseTool('Bash', {}, context('a'))).behavior).toBe('deny')
    expect(log).toHaveBeenCalledWith('native-tools', expect.stringContaining('denied Bash'))
    expect(host.onCall).not.toHaveBeenCalled()
  })

  it('aborts a waiting decision immediately on cancellation and never grants a late answer', async () => {
    const abort = new AbortController()
    let finish!: (decision: NativeDecision) => void, seenSignal: AbortSignal | undefined
    const host = native(async (_name, _input, signal) => { seenSignal = signal; return new Promise(resolve => { finish = resolve }) })
    const options = nativeOptions(() => host)
    const pending = options.canUseTool('Bash', {}, context('a', abort.signal))
    await Promise.resolve()
    abort.abort()
    expect((await pending).behavior).toBe('deny')
    expect(seenSignal?.aborted).toBe(true)
    finish({ behavior: 'allow' })
    await Promise.resolve()
    expect(host.onCall).not.toHaveBeenCalled()
  })

  it('bounds an unresponsive decision at two minutes and keeps the SDK hook alive until then', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const host = native(async (_name, _input, value) => { signal = value; return new Promise(() => {}) })
    const options = nativeOptions(() => host)
    expect(options.hooks.PreToolUse[0]!.timeout).toBeGreaterThan(120)
    const pending = options.canUseTool('Bash', {}, context('a'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect((await pending).behavior).toBe('deny')
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(host.onCall).not.toHaveBeenCalled()
  })

  it('records successful and failed native calls but not results from a stale turn', async () => {
    let host: NativeTools | undefined = native()
    const oldHost = host, options = nativeOptions(() => host)
    await options.canUseTool('Read', {}, context('a'))
    await options.hooks.PostToolUse[0]!.hooks[0]!({ tool_name: 'Read', tool_use_id: 'a', tool_response: {} })
    expect(oldHost.onResult).toHaveBeenCalledWith('Read', true)
    await options.canUseTool('Write', {}, context('b'))
    await options.hooks.PostToolUseFailure[0]!.hooks[0]!({ tool_name: 'Write', tool_use_id: 'b', error: 'disk full' })
    expect(oldHost.onResult).toHaveBeenCalledWith('Write', false)
    await options.canUseTool('Read', {}, context('c'))
    host = undefined
    await options.hooks.PostToolUse[0]!.hooks[0]!({ tool_name: 'Read', tool_use_id: 'c', tool_response: {} })
    expect(oldHost.onResult).toHaveBeenCalledTimes(2)
  })

  it('rejects already-canceled calls without asking and leaves Engram tools to their own checks', async () => {
    const decide = vi.fn(async (): Promise<NativeDecision> => ({ behavior: 'allow' }))
    const host = native(decide), options = nativeOptions(() => host), abort = new AbortController()
    abort.abort()
    expect((await options.canUseTool('Bash', {}, context('a', abort.signal))).behavior).toBe('deny')
    expect((await options.canUseTool('mcp__engram__file_read', {}, context('b'))).behavior).toBe('allow')
    expect(decide).not.toHaveBeenCalled()
  })
})
