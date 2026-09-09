import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), exists: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('node:child_process', () => ({ spawn: deps.spawn, execFile: deps.execFile }))
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

describe('desktop native readiness and request lifetime', () => {
  it('renews foreground delegation for the exact helper before binding', async () => {
    child.pid = 321
    const request = host.request('bind', { ...target, grant: 'user-grant' })
    await ready()
    respond({ id: latest('prepare'), result: { intervention: '42' } })
    await flush()
    expect(messages().at(-1)).toMatchObject({ method: 'bind', intervention: '42' })
    respond({ id: latest('bind'), result: { lease: 'native-first' } })
    await request
    expect(deps.execFile).toHaveBeenCalledWith(expect.stringMatching(/EngramDesktop\.exe$/),
      ['--owner-pid', String(process.pid), '--grant-foreground', '321'],
      { windowsHide: true, timeout: 1500 }, expect.any(Function))
  })

  it('never dispatches a bind if Stop arrives while delegation is pending', async () => {
    child.pid = 321
    let finish!: (error: Error | null) => void
    deps.execFile.mockImplementation((_path, _args, _options, done: typeof finish) => { finish = done })
    const request = host.request('bind', { ...target, grant: 'user-grant' })
    const rejected = expect(request).rejects.toThrow('cancelled by Stop')
    await ready()
    respond({ id: latest('prepare'), result: { intervention: '42' } })
    await flush()
    expect(messages().map((message) => message.method)).toEqual(['prepare'])
    await stop()
    finish(null)
    await rejected
    await flush()
    expect(messages().map((message) => message.method)).toEqual(['prepare', 'stop'])
  })

  it('spawns hidden and owner-scoped, waiting for the supported control handshake before dispatch', async () => {
    const request = host.request('inspectWindow', target)
    expect(deps.spawn).toHaveBeenCalledWith(expect.stringMatching(/native-bin[\\/]desktop[\\/]EngramDesktop\.exe$/), ['--owner-pid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(child.stdin.write).not.toHaveBeenCalled()
    await ready()
    expect(messages()).toEqual([{ id: 1, method: 'inspectWindow', ...target }])
    respond({ id: 1, result: { pid: 200 } })
    await expect(request).resolves.toEqual({ pid: 200 })
  })

  it.each([{ type: 'ready', protocol: 1, control: true }, { type: 'ready', protocol: 2, control: false }, { type: 'fatal', error: 'Hook initialization failed' }])('fails closed for an unsupported or failed helper handshake %#', async (message) => {
    const request = host.request('inspectWindow', target)
    const rejected = expect(request).rejects.toThrow('connection closed')
    respond(message)
    await rejected
    expect(child.stdin.write).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(revoked).toHaveBeenCalledOnce()
  })

  it('rejects readiness waiters immediately when the helper is explicitly closed', async () => {
    expect(host.closed).toBe(false)
    const request = host.request('bind', target)
    const rejected = expect(request).rejects.toThrow('access ended')
    host.close()
    expect(host.closed).toBe(true)
    await rejected
    await ready()
    expect(child.stdin.write).not.toHaveBeenCalled()
    await expect(host.request('observe', target)).rejects.toThrow('access ended')
    expect(deps.spawn).toHaveBeenCalledOnce()
  })

  it('Stop synchronously invalidates pre-ready work and dispatches before fresh requests', async () => {
    const old = host.request('bind', target)
    const rejected = expect(old).rejects.toThrow('cancelled by Stop')
    const stopped = host.request('stop', {})
    const fresh = host.request('inspectWindow', target)
    await rejected
    await ready()
    expect(messages().map((message) => message.method)).toEqual(['stop', 'inspectWindow'])
    respond({ id: latest('stop'), result: { stopped: true } })
    respond({ id: latest('inspectWindow'), result: { pid: 200 } })
    await Promise.all([stopped, fresh])
    expect(revoked).not.toHaveBeenCalled()
  })

  it('matches concurrent read results by ID without crossing requests', async () => {
    const first = host.request('observe', target), second = host.request('inspectWindow', target)
    await ready()
    respond({ id: latest('inspectWindow'), result: 'second' })
    respond({ id: latest('observe'), result: 'first' })
    expect(await Promise.all([first, second])).toEqual(['first', 'second'])
  })

  it('ignores malformed JSON, null messages and unrelated response IDs', async () => {
    const request = host.request('observe', target)
    await ready()
    child.stdout.write('not JSON\n')
    respond(null)
    respond({ id: 999, result: 'unrelated' })
    respond({ id: String(latest('observe')), result: 'wrong type' })
    respond({ id: latest('observe'), result: 'selected window' })
    await expect(request).resolves.toBe('selected window')
  })

  it.each(['exec', 'focus', 'setValue', 'listFiles'])('rejects unsupported method %s before spawning', async (method) => {
    await expect(host.request(method as DesktopMethod, target)).rejects.toThrow('Unsupported')
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it.each([null, [], { ...target, window: 'screen:1' }, { ...target, pid: -1 }, { ...target, pid: 1.1 }])('rejects invalid target arguments %# before spawning', async (args) => {
    await expect(host.request('observe', args as Record<string, unknown>)).rejects.toThrow()
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it('does not allow arguments to replace the transport method or response ID', async () => {
    const request = host.request('observe', { ...target, id: 999, method: 'type' })
    await ready()
    expect(messages()[0]).toMatchObject({ id: 1, method: 'observe' })
    respond({ id: 1, result: 'read' })
    await request
  })
})

describe('native revocation correlation', () => {
  it('ignores an old native revocation after stop and a new bind on the same helper', async () => {
    await bind('native-old')
    await stop()
    await bind('native-new')
    respond({ type: 'revoked', lease: 'native-old', epoch: 1, reason: 'Old session stopped' })
    expect(revoked).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    const request = host.request('observe', { ...target, lease: 'native-new' })
    await flush()
    respond({ id: latest('observe'), result: 'new session' })
    await expect(request).resolves.toBe('new session')
    respond({ type: 'revoked', lease: 'native-new', epoch: 2, reason: 'Physical input' })
    expect(revoked).toHaveBeenCalledExactlyOnceWith('Physical input')
    expect(host.closed).toBe(false)
    await bind('native-after-takeover')
    expect(host.closed).toBe(false)
  })

  it('invalidates pending native work when the current lease is revoked', async () => {
    await bind()
    const request = host.request('click', { ...target, lease: 'native-first', snapshot: 's', element: 'e0' })
    const rejected = expect(request).rejects.toThrow('Physical input')
    await flush()
    const id = latest('click')
    respond({ type: 'revoked', lease: 'native-first', reason: 'Physical input' })
    respond({ id, result: { sent: true } })
    await rejected
    expect(revoked).toHaveBeenCalledOnce()
  })

  it('rejects a bind whose native lease was revoked before its response arrived', async () => {
    const request = host.request('bind', target)
    const rejected = expect(request).rejects.toThrow('revoked')
    await ready()
    respond({ type: 'revoked', lease: 'native-racing', reason: 'Physical input' })
    expect(revoked).not.toHaveBeenCalled()
    respond({ id: latest('bind'), result: { lease: 'native-racing' } })
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
    expect(revoked).toHaveBeenCalledOnce()
  })

  it('never arms a late bind reply after Stop or lets its error close a fresh grant', async () => {
    const first = host.request('bind', target)
    const rejected = expect(first).rejects.toThrow('cancelled by Stop')
    await ready()
    const oldId = latest('bind')
    await stop()
    await rejected
    await bind('native-fresh')
    respond({ id: oldId, result: { lease: 'native-old' } })
    respond({ id: oldId, error: 'Old bind failed' })
    respond({ type: 'revoked', lease: 'native-old', reason: 'Old revoke' })
    expect(child.kill).not.toHaveBeenCalled()
    expect(revoked).not.toHaveBeenCalled()
    respond({ type: 'revoked', lease: 'native-fresh', reason: 'Current revoke' })
    expect(revoked).toHaveBeenCalledExactlyOnceWith('Current revoke')
  })

  it('rejects duplicate native binds without disrupting the accepted binding', async () => {
    const first = host.request('bind', target)
    await expect(host.request('bind', target)).rejects.toThrow('active or pending')
    await ready()
    respond({ id: latest('bind'), result: { lease: 'native-first' } })
    await first
    await expect(host.request('bind', target)).rejects.toThrow('active or pending')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it.each([null, {}, { lease: '' }, { lease: 'x'.repeat(101) }, { lease: 'bad\0lease' }])('fails closed on an invalid bind result %#', async (result) => {
    const request = host.request('bind', target)
    const rejected = expect(request).rejects.toThrow('could not be verified')
    await ready()
    respond({ id: latest('bind'), result })
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('does not permit reuse of a retired native lease even before its revoke event arrives', async () => {
    await bind('retired')
    await stop()
    const request = host.request('bind', target)
    const rejected = expect(request).rejects.toThrow('revoked')
    await flush()
    respond({ id: latest('bind'), result: { lease: 'retired' } })
    await rejected
  })

  it('keeps the native reason when control is revoked before binding is acknowledged', async () => {
    const request = host.request('bind', target)
    const rejected = expect(request).rejects.toThrow('Desktop stop monitoring stalled')
    await ready()
    respond({ type: 'revoked', lease: 'early', reason: 'Desktop stop monitoring stalled' })
    respond({ id: latest('bind'), result: { lease: 'early' } })
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('keeps pre-response revocation history bounded and fails closed instead of forgetting revocations', async () => {
    const request = host.request('bind', target)
    const rejected = expect(request).rejects.toThrow('history is full')
    await ready()
    for (let i = 0; i < 129; i++) respond({ type: 'revoked', lease: `lease-${i}`, reason: 'Stopped' })
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
  })
})

describe('desktop transport failures', () => {
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

  it.each(['ready', 'request'])('closes on the %s watchdog without retrying native input', async (phase) => {
    const request = host.request('observe', target)
    const rejected = expect(request).rejects.toThrow(phase === 'ready' ? 'connection closed' : 'stopped responding')
    if (phase === 'request') await ready()
    await vi.advanceTimersByTimeAsync(phase === 'ready' ? 10_001 : 8_001)
    await rejected
    expect(child.kill).toHaveBeenCalledOnce()
    expect(revoked).toHaveBeenCalledOnce()
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
