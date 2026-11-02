import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const deps = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), exists: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('node:child_process', () => ({ spawn: deps.spawn, execFile: deps.execFile }))
vi.mock('../src/main/process-client.js', () => ({ ProcessClient: class { constructor(...args: unknown[]) { return deps.spawn(...args) } } }))
vi.mock('node:fs', () => ({ existsSync: deps.exists }))
import { DesktopHost, type DesktopMethod } from '../src/main/desktop-host.js'
function processDouble() {
  return Object.assign(new EventEmitter(), {
    pid: undefined as number | undefined,
    stdin: Object.assign(new EventEmitter(), {
      destroyed: false,
      write: vi.fn((_data: string, callback?: (error?: Error) => void) => { callback?.(); return true }),
      end: vi.fn(),
    }),
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  })
}
const target = { window: '100', pid: 200 }
let child: ReturnType<typeof processDouble>
let host: DesktopHost
let revoked: ReturnType<typeof vi.fn<(reason: string) => void>>
function respond(message: unknown): void { child.stdout.write(JSON.stringify(message) + '\n') }
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
async function ready(): Promise<void> { respond({ type: 'ready', protocol: 2, control: true }); await flush() }
function messages(): { id: number; method: DesktopMethod; [key: string]: unknown }[] {
  return child.stdin.write.mock.calls.map(([line]) => JSON.parse(line) as { id: number; method: DesktopMethod })
}
function latest(method: DesktopMethod): number { return messages().filter((message) => message.method === method).at(-1)!.id }
async function bind(id = 'native-first'): Promise<void> {
  const request = host.request('bind', { ...target, grant: 'user-grant' })
  await ready()
  respond({ id: latest('bind'), result: { lease: id } })
  await request
}
async function stop(): Promise<void> {
  const request = host.request('stop', {})
  await flush()
  respond({ id: latest('stop'), result: { stopped: true } })
  await request
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.useFakeTimers()
  child = processDouble()
  deps.spawn.mockReturnValue(child)
  deps.execFile.mockImplementation((_path, _args, _options, done: (error: Error | null) => void) => done(null))
  deps.exists.mockReturnValue(true)
  vi.spyOn(DesktopHost, 'available').mockReturnValue(true)
  revoked = vi.fn()
  host = new DesktopHost(revoked)
})
afterEach(() => {
  host.close()
  child.stdout.destroy()
  child.stderr.destroy()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
describe('desktop transport failures', () => {
  it.each(['', '   '])('rejects an empty native error instead of returning success: %j', async error => {
    const pending = host.request('quietScan', target), outcome = expect(pending).rejects.toThrow('The desktop request failed.')
    await ready(); respond({ id: latest('quietScan'), error }); await outcome
  })
  it('keeps the connection usable when held keys postpone preparation', async () => {
    child.pid = 321
    const first = host.request('bind', { ...target, grant: 'first' })
    const rejected = expect(first).rejects.toThrow('Release your keyboard')
    await ready()
    respond({ id: latest('prepare'), error: 'Release your keyboard and mouse before allowing control' })
    await rejected
    expect(host.closed).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    expect(deps.execFile).not.toHaveBeenCalled()
    const next = host.request('bind', { ...target, grant: 'next' })
    await flush()
    respond({ id: latest('prepare'), result: { intervention: '7' } })
    await flush()
    respond({ id: latest('bind'), result: { lease: 'recovered' } })
    await expect(next).resolves.toEqual({ lease: 'recovered' })
  })
  it.each(['exit', 'error', 'stdin-error', 'stdout-error'])('revokes all access on %s regardless of the current native ID', async (event) => {
    await bind()
    const request = host.request('observe', target)
    const rejected = expect(request).rejects.toThrow('connection closed')
    await flush()
    if (event === 'stdin-error') child.stdin.emit('error', new Error('Pipe failure'))
    else if (event === 'stdout-error') child.stdout.emit('error', new Error('Pipe failure'))
    else child.emit(event, event === 'error' ? new Error('Transport failure') : 1)
    await rejected
    expect(revoked).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(host.closed).toBe(true)
  })

  it('closes if native bind fails after dispatch and never automatically restarts', async () => {
    const request = host.request('bind', target)
    const rejected = expect(request).rejects.toThrow('Hooks unavailable')
    await ready()
    respond({ id: latest('bind'), error: 'Hooks unavailable' })
    await rejected
    await expect(host.request('bind', target)).rejects.toThrow('access ended')
    expect(deps.spawn).toHaveBeenCalledOnce()
    expect(revoked).toHaveBeenCalledOnce()
  })

  it.each(['ready', 'request'])('only closes an unready helper on the %s watchdog', async (phase) => {
    const request = host.request('observe', target)
    const rejected = expect(request).rejects.toThrow(phase === 'ready' ? 'connection closed' : 'stopped responding')
    if (phase === 'request') await ready()
    await vi.advanceTimersByTimeAsync(phase === 'ready' ? 25_001 : 30_001)
    await rejected
    expect(child.kill).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0)
    expect(revoked).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0)
  })
  it('times out one request, ignores its late reply and continues using the same helper', async () => {
    const slow = host.request('quietScan', target)
    const rejected = expect(slow).rejects.toThrow('within 30 seconds')
    await ready()
    const old = latest('quietScan')
    await vi.advanceTimersByTimeAsync(20_000)
    const next = host.request('quietRead', target)
    await flush()
    await vi.advanceTimersByTimeAsync(10_001)
    await rejected
    respond({ id: old, result: { snapshot: 'late' } })
    respond({ id: latest('quietRead'), result: { text: 'still connected' } })
    expect(await next).toEqual({ text: 'still connected' })
    expect(host.closed).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    expect(deps.spawn).toHaveBeenCalledOnce()
  })

  it('revokes a timed-out bind without killing the helper or unrelated reads', async () => {
    Object.assign(child, { pid: 1234 })
    const pending = host.request('bind', target)
    const rejected = expect(pending).rejects.toThrow('within 30 seconds')
    await ready()
    respond({ id: latest('prepare'), result: { intervention: '42' } })
    await flush()
    const old = latest('bind')
    await vi.advanceTimersByTimeAsync(20_000)
    const reading = host.request('quietRead', target)
    await flush()
    await vi.advanceTimersByTimeAsync(10_001)
    await rejected
    expect(messages().at(-1)?.method).toBe('stop')
    respond({ id: old, result: { lease: 'late-grant' } })
    respond({ id: latest('quietRead'), result: { text: 'alive' } })
    expect(await reading).toEqual({ text: 'alive' })
    expect(host.closed).toBe(false)
  })

  it('fails only the bind when its preparation request times out', async () => {
    Object.assign(child, { pid: 1234 })
    const pending = host.request('bind', target)
    const rejected = expect(pending).rejects.toThrow('within 30 seconds')
    await ready()
    await vi.advanceTimersByTimeAsync(30_001)
    await rejected
    expect(host.closed).toBe(false)
    expect(messages().some(message => message.method === 'bind')).toBe(false)
  })

  it('cancels a request without killing the helper or another pending read', async () => {
    const abort = new AbortController()
    const canceled = host.request('quietScan', target, abort.signal)
    const rejected = expect(canceled).rejects.toThrow('Stopped')
    await ready()
    const next = host.request('quietRead', target)
    await flush()
    abort.abort(new Error('Stopped'))
    await rejected
    expect(messages()).toContainEqual(expect.objectContaining({ method: 'cancel', target: latest('quietScan') }))
    respond({ id: latest('quietRead'), result: { text: 'ready' } })
    expect(await next).toEqual({ text: 'ready' })
    expect(host.closed).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('clears old request watchdogs when Stop supersedes their generation', async () => {
    await bind('old')
    const request = host.request('observe', target)
    const rejected = expect(request).rejects.toThrow('cancelled by Stop')
    await flush()
    await stop()
    await rejected
    await bind('new')
    await vi.advanceTimersByTimeAsync(10_001)
    expect(child.kill).not.toHaveBeenCalled()
    expect(revoked).not.toHaveBeenCalled()
  })

  it('closes on write callback failure and malformed revocation messages', async () => {
    child.stdin.write.mockImplementation((_line, callback) => { callback?.(new Error('Pipe closed')); return false })
    const request = host.request('observe', target)
    const rejected = expect(request).rejects.toThrow('Pipe closed')
    await ready()
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
    respond({ type: 'revoked', reason: 'Late malformed message' })
    expect(revoked).toHaveBeenCalledOnce()
  })

  it('fails closed when an uncorrelatable revoke arrives on a live connection', async () => {
    await bind()
    respond({ type: 'revoked', reason: 'Missing native identity' })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(revoked).toHaveBeenCalledOnce()
  })
})

it('preempts a preview when real work arrives without cancelling the real request', async () => {
  const preview = host.request('observe', target, undefined, { preview: true })
  const cancelled = expect(preview).rejects.toThrow('may have partly happened')
  await ready()
  const id = latest('observe')
  const work = host.request('quietRead', target)
  await cancelled; await flush()
  expect(messages()).toContainEqual(expect.objectContaining({ method: 'cancel', target: id }))
  respond({ id: latest('quietRead'), result: { text: 'work' } })
  expect(await work).toEqual({ text: 'work' })
  await vi.advanceTimersByTimeAsync(60001)
  expect(host.closed).toBe(false)
})

it('retires only a helper whose cancelled read never returns, without restarting or replaying', async () => {
  const pending = host.request('quietScan', target)
  const failed = expect(pending).rejects.toThrow('within 30 seconds')
  await ready(); await vi.advanceTimersByTimeAsync(30001); await failed
  expect(host.closed).toBe(false)
  await vi.advanceTimersByTimeAsync(30001)
  expect(host.closed).toBe(true)
  expect(child.kill).toHaveBeenCalledOnce()
  expect(deps.spawn).toHaveBeenCalledOnce()
})
