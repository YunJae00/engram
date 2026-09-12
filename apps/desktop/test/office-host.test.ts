import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => 'unused' } }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), writeFile: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: fake.spawn }))

function worker() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn((_line: string, done?: (error?: Error) => void) => done?.()) },
    stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null,
    kill: vi.fn(() => true),
  })
  return proc
}

let host: typeof import('../src/main/office-host.js')
let proc: ReturnType<typeof worker>
beforeEach(async () => {
  vi.resetModules()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  proc = worker()
  fake.spawn.mockReturnValue(proc)
  host = await import('../src/main/office-host.js')
})
afterEach(() => {
  host.closeOfficeHost()
  proc.exitCode = 0
  proc.emit('exit', 0)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
async function ready() {
  await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled())
  proc.stdout.write('{"type":"ready"}\n')
}

it('does not dispatch when aborted while starting', async () => {
  const controller = new AbortController()
  const result = host.officeRequest('excel.write', {}, controller.signal).catch((e: Error) => e)
  controller.abort()
  // A queued abort may prevent startup altogether.
  const error = await result
  expect(error).toBeInstanceOf(Error)
  expect(proc.stdin.write).not.toHaveBeenCalled()
})

it('rechecks cancellation after startup awaits', async () => {
  const controller = new AbortController()
  const result = host.officeRequest('excel.write', {}, controller.signal).catch((e: Error) => e)
  await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled())
  controller.abort()
  proc.stdout.write('{"type":"ready"}\n')
  expect(await result).toBeInstanceOf(Error)
  expect(proc.stdin.write).not.toHaveBeenCalled()
  expect(proc.kill).toHaveBeenCalledOnce()
})

it('kills only the bridge on cancellation and waits for exit before another request', async () => {
  const controller = new AbortController()
  const result = host.officeRequest('excel.write', {}, controller.signal).catch((e: Error) => e)
  await ready()
  await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce())
  controller.abort()
  expect((await result as Error).message).toContain('partial')
  expect(proc.kill).toHaveBeenCalledOnce()
  const next = host.officeRequest('probe', {}).catch((e: Error) => e)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(fake.spawn).toHaveBeenCalledOnce()
  proc.exitCode = 0
  proc.emit('exit', 0)
  const nextProc = worker()
  fake.spawn.mockReturnValue(nextProc)
  await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalledTimes(2))
  proc = nextProc
  proc.stdout.write('{"type":"ready"}\n')
  await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce())
  const sent = JSON.parse(proc.stdin.write.mock.calls[0]![0])
  proc.stdout.write(JSON.stringify({ id: sent.id, ok: true, result: 'ready' }) + '\n')
  expect(await next).toBe('ready')
})

it('stops the worker on a desktop turn stop', async () => {
  let stopped = false
  const result = host.officeRequest('excel.write', {}, undefined, () => { if (stopped) throw new Error('stopped') }).catch((e: Error) => e)
  await ready()
  await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce())
  stopped = true
  expect((await result as Error).message).toContain('partial')
  expect(proc.kill).toHaveBeenCalledOnce()
})

it('terminates the worker on request timeout', async () => {
  const result = host.officeRequest('excel.write', {}).catch((e: Error) => e)
  await ready()
  // The write timer must be created under the fake clock.
  // This request is already running, so complete it and time the next one.
  await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce())
  const first = JSON.parse(proc.stdin.write.mock.calls[0]![0])
  proc.stdout.write(JSON.stringify({ id: first.id, ok: true, result: {} }) + '\n')
  await result
  vi.useFakeTimers()
  const timed = host.officeRequest('excel.write', {}).catch((e: Error) => e)
  await vi.advanceTimersByTimeAsync(90_001)
  expect((await timed as Error).message).toContain('did not finish in time')
  expect(proc.kill).toHaveBeenCalledOnce()
})

it('acknowledges an application window only after its visible activity handler is ready', async () => {
  let show!: () => void
  const activity = vi.fn(() => new Promise<void>((resolve) => { show = resolve }))
  const result = host.officeRequest('ppt.read', {}, undefined, undefined, activity)
  await ready()
  await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce())
  const request = JSON.parse(proc.stdin.write.mock.calls[0]![0])
  expect(request.activity).toBe(true)
  proc.stdout.write(JSON.stringify({ type: 'activity', id: request.id, window: '123', name: 'PowerPoint' }) + '\n')
  await vi.waitFor(() => expect(activity).toHaveBeenCalledWith('123', 'PowerPoint'))
  expect(proc.stdin.write).toHaveBeenCalledOnce()
  show()
  await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledTimes(2))
  expect(JSON.parse(proc.stdin.write.mock.calls[1]![0])).toEqual({ activity: request.id })
  proc.stdout.write(JSON.stringify({ id: request.id, ok: true, result: 'read' }) + '\n')
  expect(await result).toBe('read')
})

it('does not acknowledge a window if the request is cancelled while the overlay loads', async () => {
  let show!: () => void
  const activity = vi.fn(() => new Promise<void>((resolve) => { show = resolve }))
  const controller = new AbortController()
  const result = host.officeRequest('ppt.read', {}, controller.signal, undefined, activity).catch((e: Error) => e)
  await ready()
  await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalledOnce())
  const request = JSON.parse(proc.stdin.write.mock.calls[0]![0])
  proc.stdout.write(JSON.stringify({ type: 'activity', id: request.id, window: '123', name: 'PowerPoint' }) + '\n')
  await vi.waitFor(() => expect(activity).toHaveBeenCalled())
  controller.abort(); show()
  expect(await result).toBeInstanceOf(Error)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(proc.stdin.write).toHaveBeenCalledOnce()
})
