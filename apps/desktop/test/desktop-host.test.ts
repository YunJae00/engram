import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({ spawn: vi.fn(), exists: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('node:child_process', () => ({ spawn: deps.spawn }))
vi.mock('node:fs', () => ({ existsSync: deps.exists }))
import { DesktopHost } from '../src/main/desktop-host.js'

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn((_data: string, callback?: (error?: Error) => void) => { callback?.(); return true }), end: vi.fn() },
    stdout: new PassThrough(), stderr: Object.assign(new PassThrough(), { resume: vi.fn() }), kill: vi.fn(),
  })
}
let child: ReturnType<typeof childProcess>
let host: DesktopHost
function respond(message: unknown) { child.stdout.write(JSON.stringify(message) + '\n') }
const args = { window: '100', pid: 200 }

beforeEach(() => {
  vi.clearAllMocks()
  child = childProcess()
  deps.spawn.mockReturnValue(child)
  deps.exists.mockReturnValue(true)
  vi.spyOn(DesktopHost, 'available').mockReturnValue(true)
  host = new DesktopHost()
})
afterEach(() => {
  host.close()
  child.stdout.destroy(); child.stderr.destroy()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('desktop helper transport', () => {
  it('starts only when requested with a hidden, owner-scoped process', async () => {
    expect(deps.spawn).not.toHaveBeenCalled()
    const request = host.request('inspectWindow', args)
    expect(deps.spawn).toHaveBeenCalledWith(expect.stringMatching(/native-bin[\\/]desktop[\\/]EngramDesktop\.exe$/), ['--owner-pid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(JSON.parse(child.stdin.write.mock.calls[0]![0])).toEqual({ id: 1, method: 'inspectWindow', ...args })
    respond({ id: 1, result: { pid: 200, title: 'App' } })
    expect(await request).toEqual({ pid: 200, title: 'App' })
  })

  it.each(['act', 'invoke', 'setValue', 'focus', 'click'])('rejects unsupported helper method %s before spawning', (method) => {
    expect(() => host.request(method as 'observe', args)).toThrow('Only app inspection and reading')
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it.each([{ ...args, method: 'act' }, { ...args, id: 999 }, { ...args, window: 'screen:1' }, { ...args, pid: -1 }])('rejects arguments that can replace the read-only request envelope', (input) => {
    expect(() => host.request('observe', input)).toThrow('valid app window')
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it('matches concurrent replies by id and does not cross their results', async () => {
    const first = host.request('observe', args)
    const second = host.request('inspectWindow', args)
    respond({ id: 2, result: 'second' }); respond({ id: 1, result: 'first' })
    expect(await Promise.all([first, second])).toEqual(['first', 'second'])
    expect(deps.spawn).toHaveBeenCalledOnce()
  })

  it('ignores malformed JSON and unrelated reply ids', async () => {
    const request = host.request('observe', args)
    child.stdout.write('not json\n')
    respond({ type: 'ready', protocol: 1 }); respond({ id: 999, result: 'unrelated' })
    respond({ id: 1, result: 'selected window' })
    expect(await request).toBe('selected window')
  })

  it('does not crash the main process on a null protocol message', async () => {
    const request = host.request('observe', args)
    const result = request.catch((error: unknown) => error)
    expect(() => respond(null)).not.toThrow()
    respond({ id: 1, result: 'selected window' })
    expect(await result).toBe('selected window')
  })

  it('propagates a scoped helper error without silently retrying', async () => {
    const request = host.request('observe', args)
    respond({ id: 1, error: 'Window expired' })
    await expect(request).rejects.toThrow('Window expired')
    expect(deps.spawn).toHaveBeenCalledOnce()
    expect(child.stdin.write).toHaveBeenCalledOnce()
  })

  it.each(['exit', 'error'])('permanently closes after helper %s and rejects every pending request', async (event) => {
    const first = host.request('observe', args)
    const second = host.request('inspectWindow', args)
    const results = Promise.allSettled([first, second])
    child.emit(event, event === 'error' ? new Error('Child failed') : 1)
    for (const result of await results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(String(result.reason)).toContain('connection closed')
    }
    expect(() => host.request('observe', args)).toThrow('App sharing stopped')
    expect(deps.spawn).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('kills a timed-out helper and never automatically restarts it', async () => {
    vi.useFakeTimers()
    const request = host.request('observe', args)
    const outcome = expect(request).rejects.toThrow('stopped responding')
    await vi.advanceTimersByTimeAsync(8001)
    await outcome
    expect(child.kill).toHaveBeenCalledOnce()
    expect(() => host.request('observe', args)).toThrow('App sharing stopped')
    expect(deps.spawn).toHaveBeenCalledOnce()
  })

  it('clears the watchdog when a request completes', async () => {
    vi.useFakeTimers()
    const request = host.request('observe', args)
    respond({ id: 1, result: 'done' })
    await request
    await vi.advanceTimersByTimeAsync(8001)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('fails closed on an oversized response', async () => {
    const request = host.request('observe', args)
    const outcome = expect(request).rejects.toThrow('too much information')
    child.stdout.write('x'.repeat(262145) + '\n')
    await outcome
    expect(child.kill).toHaveBeenCalledOnce()
    expect(() => host.request('observe', args)).toThrow('App sharing stopped')
  })

  it('closes pending work when writing to the helper fails', async () => {
    child.stdin.write.mockImplementation((_data, callback) => { callback?.(new Error('Pipe closed')); return false })
    await expect(host.request('observe', args)).rejects.toThrow('Pipe closed')
    expect(child.kill).toHaveBeenCalledOnce()
    expect(() => host.request('observe', args)).toThrow('App sharing stopped')
  })

  it('requires a fresh instance after explicit close, even before first start', () => {
    host.close()
    expect(() => host.request('observe', args)).toThrow('App sharing stopped')
    expect(deps.spawn).not.toHaveBeenCalled()
  })

  it('rejects an unavailable helper without spawning anything', () => {
    vi.mocked(DesktopHost.available).mockReturnValue(false)
    expect(() => host.request('observe', args)).toThrow('available on Windows')
    expect(deps.spawn).not.toHaveBeenCalled()
  })
})
