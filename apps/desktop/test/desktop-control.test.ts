import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBinding } from '../src/main/desktop-access.js'
import type { DesktopHost, DesktopMethod } from '../src/main/desktop-host.js'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const deps = vi.hoisted(() => ({
  bindings: new Map<string, unknown>(), owner: undefined as object | undefined,
  dialog: vi.fn(), changed: vi.fn(), broadcast: vi.fn(),
  release: undefined as ((lane: string, reason: string) => void) | undefined,
}))
vi.mock('electron', () => ({ dialog: { showMessageBox: deps.dialog } }))
vi.mock('../src/main/desktop-access.js', () => ({
  desktopBinding: (lane: string) => deps.bindings.get(lane),
  desktopOwner: () => deps.owner,
  desktopChanged: deps.changed,
  setDesktopReleaseHook: (hook: typeof deps.release) => { deps.release = hook },
}))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: deps.broadcast }))

const lane = 'bot-first'
const other = 'bot-second'
let control: typeof import('../src/main/desktop-control.js')

function observation(snapshot = 'snapshot-1'): DesktopObservationDto {
  return { snapshot, nodes: [{ id: 'e0', name: 'Editor', controlType: 'Edit', bounds: { x: -1000, y: 20, width: 200, height: 100 } }], bounds: { x: -1000, y: 20, width: 200, height: 100 }, captureBounds: { x: -992, y: 44, width: 184, height: 68 } }
}

function binding(owner = lane, window = '100') {
  let serial = 0
  const request = vi.fn<(method: DesktopMethod, args: Record<string, unknown>) => Promise<unknown>>(async (method) => {
    if (method === 'bind') return { lease: `native-${window}` }
    if (method === 'observe') return observation(`snapshot-${++serial}`)
    return { ok: true }
  })
  const close = vi.fn()
  const value: DesktopBinding = { lane: owner, source: `window:${window}:0`, name: 'Editor', window, pid: 200, readable: false, stopped: false, revision: 0, host: { request, close } as unknown as DesktopHost }
  deps.bindings.set(owner, value)
  return { value, request, close }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  deps.bindings.clear()
  deps.owner = { id: 'main-window' }
  deps.dialog.mockReset().mockResolvedValue({ response: 1 })
  deps.changed.mockReset()
  deps.broadcast.mockReset()
  deps.release = undefined
  control = await import('../src/main/desktop-control.js')
  control.setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
})
afterEach(() => {
  control.stopDesktopControl('Test cleanup')
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('foreground control consent', () => {
  it('requires a selected window and a live owner', async () => {
    await expect(control.startDesktopControl(lane)).rejects.toThrow('Choose an app window')
    const host = binding()
    deps.owner = undefined
    await expect(control.startDesktopControl(lane)).rejects.toThrow('Choose an app window')
    expect(deps.dialog).not.toHaveBeenCalled()
    expect(host.request).not.toHaveBeenCalled()
  })

  it('does not grant access or native input when the person cancels', async () => {
    const host = binding()
    deps.dialog.mockResolvedValue({ response: 0 })
    await expect(control.startDesktopControl(lane)).rejects.toThrow('not allowed')
    expect(control.desktopControlStatus().state).toBe('paused')
    expect(host.value.readable).toBe(false)
    expect(host.request).not.toHaveBeenCalled()
  })

  it.each(['binding', 'host'] as const)('requires reconnect instead of granting a terminal %s connection', async (closed) => {
    const host = binding()
    if (closed === 'binding') host.value.stopped = true
    else Object.defineProperty(host.value.host, 'closed', { value: true })
    await expect(control.startDesktopControl(lane)).rejects.toThrow('Reconnect the app window to continue.')
    expect(control.desktopControlStatus().state).toBe('idle')
    expect(deps.dialog).not.toHaveBeenCalled()
    expect(host.request).not.toHaveBeenCalled()
    expect(host.value.readable).toBe(false)
  })

  it('allows a fresh grant after ordinary user takeover without reconnecting', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    await control.readControlledDesktop(lane, undefined, true)
    deps.release!(lane, 'Mouse input returned control to the user')
    expect(host.value.stopped).toBe(false)
    expect(await control.startDesktopControl(lane)).toMatchObject({ state: 'ready', lane })
    expect(host.close).not.toHaveBeenCalled()
  })

  it('arms a ready grant without binding native input while the person writes their task', async () => {
    const host = binding()
    expect(await control.startDesktopControl(lane)).toMatchObject({ state: 'ready', lane, name: 'Editor' })
    expect(host.value.readable).toBe(true)
    expect(host.request).not.toHaveBeenCalled()
    expect(host.close).not.toHaveBeenCalled()
    expect(deps.dialog.mock.calls[0]![1]).toMatchObject({ defaultId: 0, cancelId: 0 })
    expect(deps.dialog.mock.calls[0]![1].detail).toContain('real desktop')
    expect(deps.dialog.mock.calls[0]![1].detail).toContain('screenshots')
  })

  it.each([false, true])('allows only one global pending or ready owner, ready=%s', async (ready) => {
    binding()
    binding(other, '101')
    const answer = deferred<{ response: number }>()
    deps.dialog.mockReturnValue(answer.promise)
    const first = control.startDesktopControl(lane)
    if (ready) { answer.resolve({ response: 1 }); await first }
    await expect(control.startDesktopControl(other)).rejects.toThrow('pending or running')
    await expect(control.startDesktopControl(lane)).rejects.toThrow('pending or running')
    expect(deps.dialog).toHaveBeenCalledOnce()
    if (!ready) { answer.resolve({ response: 1 }); await first }
  })

  it('does not accept permission delivered after Stop', async () => {
    const host = binding()
    const answer = deferred<{ response: number }>()
    deps.dialog.mockReturnValue(answer.promise)
    const request = control.startDesktopControl(lane)
    const rejected = expect(request).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(deps.dialog).toHaveBeenCalled())
    control.stopDesktopControl()
    answer.resolve({ response: 1 })
    await rejected
    expect(host.request).not.toHaveBeenCalled()
    expect(control.desktopControlStatus().state).toBe('paused')
  })

  it('does not let a stale same-lane approval cancel a newer pending grant', async () => {
    binding()
    const old = deferred<{ response: number }>(), fresh = deferred<{ response: number }>()
    deps.dialog.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const first = control.startDesktopControl(lane)
    const rejected = expect(first).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(deps.dialog).toHaveBeenCalled())
    control.stopDesktopControl()
    const next = control.startDesktopControl(lane)
    old.resolve({ response: 1 })
    await rejected
    expect(control.desktopControlStatus().state).toBe('needs-person')
    fresh.resolve({ response: 1 })
    expect(await next).toMatchObject({ state: 'ready', lane })
  })

  it.each(['source', 'owner'] as const)('rejects permission if the %s was replaced while the dialog was open', async (replacement) => {
    const host = binding()
    const answer = deferred<{ response: number }>()
    deps.dialog.mockReturnValue(answer.promise)
    const request = control.startDesktopControl(lane)
    const rejected = expect(request).rejects.toThrow('cancelled')
    if (replacement === 'source') binding(lane, '102')
    else deps.owner = { id: 'replacement-window' }
    answer.resolve({ response: 1 })
    await rejected
    expect(host.request).not.toHaveBeenCalled()
  })
})

describe('desktop observation and lazy native binding', () => {
  it('allows an authorized UI read without binding or foreground takeover', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    await control.readControlledDesktop(lane, undefined, false)
    expect(host.request).toHaveBeenCalledExactlyOnceWith('observe', { window: '100', pid: 200 })
    expect(control.desktopControlStatus().state).toBe('ready')
  })

  it('allows read-only consent without ever creating a control grant', async () => {
    const host = binding()
    host.value.readable = true
    await control.readControlledDesktop(lane, undefined, true)
    expect(host.request).toHaveBeenCalledExactlyOnceWith('observe', { window: '100', pid: 200 })
    expect(control.desktopControlStatus().state).toBe('idle')
  })

  it('binds on the first agent read, carries the native token and reuses only that binding', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    await control.readControlledDesktop(lane, undefined, true)
    expect(host.request).toHaveBeenNthCalledWith(1, 'bind', { window: '100', pid: 200, grant: expect.any(String) })
    expect(host.request).toHaveBeenNthCalledWith(2, 'observe', { window: '100', pid: 200, lease: 'native-100' })
    expect(control.desktopControlStatus().state).toBe('running')
    await control.readControlledDesktop(lane, undefined, true)
    expect(host.request.mock.calls.filter(([method]) => method === 'bind')).toHaveLength(1)
  })

  it('stops an in-flight bind and refuses to issue observation afterward', async () => {
    const host = binding()
    const gate = deferred<unknown>()
    await control.startDesktopControl(lane)
    host.request.mockReturnValueOnce(gate.promise)
    const read = control.readControlledDesktop(lane, undefined, true)
    const rejected = expect(read).rejects.toThrow()
    control.stopDesktopControl()
    expect(host.close).toHaveBeenCalledOnce()
    gate.resolve({ lease: 'too-late' })
    await rejected
    expect(host.request.mock.calls.map(([method]) => method)).toEqual(['bind'])
  })

  it('revokes immediately when cancellation arrives during lazy bind', async () => {
    const host = binding()
    const gate = deferred<unknown>()
    const signal = new AbortController()
    await control.startDesktopControl(lane)
    host.request.mockReturnValueOnce(gate.promise)
    const read = control.readControlledDesktop(lane, signal.signal, true)
    const rejected = expect(read).rejects.toThrow()
    signal.abort(new Error('Chat cancelled'))
    const stoppedImmediately = host.close.mock.calls.length > 0 && control.desktopControlStatus().state === 'paused'
    gate.resolve({ lease: 'too-late' })
    await rejected
    expect(stoppedImmediately).toBe(true)
    expect(host.request.mock.calls.map(([method]) => method)).toEqual(['bind'])
  })

  it('revokes the native grant immediately when an agent observation is cancelled', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    await control.readControlledDesktop(lane, undefined, true)
    const gate = deferred<unknown>(), signal = new AbortController()
    host.request.mockReturnValueOnce(gate.promise)
    const read = control.readControlledDesktop(lane, signal.signal, true)
    const rejected = expect(read).rejects.toThrow()
    signal.abort(new Error('Chat cancelled'))
    const stoppedImmediately = control.desktopControlStatus().state === 'paused'
    gate.resolve(observation('late'))
    await rejected
    expect(stoppedImmediately).toBe(true)
    expect(host.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
  })

  it('discards results after a source replacement and its release hook', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    await control.readControlledDesktop(lane, undefined, true)
    const gate = deferred<unknown>()
    host.request.mockReturnValueOnce(gate.promise)
    const read = control.readControlledDesktop(lane, undefined, true)
    const rejected = expect(read).rejects.toThrow()
    deps.release!(lane, 'Source replaced')
    binding(lane, '101')
    gate.resolve(observation('late'))
    await rejected
    expect(control.desktopControlStatus().state).toBe('paused')
  })

  it('stops native control after an agent read fails', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    await control.readControlledDesktop(lane, undefined, true)
    host.request.mockRejectedValueOnce(new Error('UIA read failed'))
    await expect(control.readControlledDesktop(lane, undefined, true)).rejects.toThrow('UIA read failed')
    expect(control.desktopControlStatus().state).toBe('paused')
    expect(host.value.readable).toBe(false)
    expect(host.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
  })
})

describe('foreground desktop actions', () => {
  it('requires a bound native lease and the latest unconsumed snapshot', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    const action = { kind: 'click' as const, snapshot: 'snapshot-1', element: 'e0' }
    await expect(control.actOnDesktop(lane, action)).rejects.toThrow('not active')
    await control.readControlledDesktop(lane, undefined, true)
    const latest = await control.readControlledDesktop(lane, undefined, true)
    await expect(control.actOnDesktop(lane, action)).rejects.toThrow('stale')
    await control.actOnDesktop(lane, { ...action, snapshot: latest.snapshot })
    await expect(control.actOnDesktop(lane, { ...action, snapshot: latest.snapshot })).rejects.toThrow('stale')
    expect(host.request.mock.calls.filter(([method]) => method === 'click')).toHaveLength(1)
  })

  it('maps normalized coordinates into client bounds on a negative-origin monitor', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    const read = await control.readControlledDesktop(lane, undefined, true)
    await control.actOnDesktop(lane, { kind: 'click', snapshot: read.snapshot, x: 1, y: 0 })
    expect(host.request).toHaveBeenCalledWith('click', { window: '100', pid: 200, lease: 'native-100', snapshot: read.snapshot, x: -809, y: 44 })
  })

  it('does not expose typing text through its result, status or change notifications', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    const read = await control.readControlledDesktop(lane, undefined, true)
    const text = 'private document content'
    const result = await control.actOnDesktop(lane, { kind: 'type', snapshot: read.snapshot, text })
    expect(host.request).toHaveBeenCalledWith('type', expect.objectContaining({ text }))
    expect(result).toContain('verify the outcome')
    expect(JSON.stringify([result, control.desktopControlStatus(), deps.changed.mock.calls, deps.broadcast.mock.calls])).not.toContain(text)
  })

  it('revokes and requests native stop when an action fails', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    const read = await control.readControlledDesktop(lane, undefined, true)
    host.request.mockRejectedValueOnce(new Error('Native failure'))
    await expect(control.actOnDesktop(lane, { kind: 'click', snapshot: read.snapshot, element: 'e0' })).rejects.toThrow('Native failure')
    expect(control.desktopControlStatus().state).toBe('paused')
    expect(host.value.readable).toBe(false)
    expect(host.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
  })

  it.each(['failure', 'abort'] as const)('does not let an old action %s revoke a new same-lane grant', async (cause) => {
    const host = binding()
    await control.startDesktopControl(lane)
    const read = await control.readControlledDesktop(lane, undefined, true)
    const gate = deferred<unknown>(), signal = new AbortController()
    host.request.mockReturnValueOnce(gate.promise)
    const action = control.actOnDesktop(lane, { kind: 'click', snapshot: read.snapshot, element: 'e0' }, signal.signal)
    const rejected = expect(action).rejects.toThrow()
    control.stopDesktopControl()
    await control.startDesktopControl(lane)
    if (cause === 'abort') { signal.abort(new Error('Old turn cancelled')); gate.resolve({ ok: true }) }
    else gate.reject(new Error('Old action failed'))
    await rejected
    expect(control.desktopControlStatus()).toMatchObject({ state: 'ready', lane })
    expect(host.value.readable).toBe(true)
  })

  it('expires a native grant without another call and stops only the owning lane', async () => {
    const host = binding()
    await control.startDesktopControl(lane)
    await control.readControlledDesktop(lane, undefined, true)
    deps.release!(other, 'Other chat ended')
    expect(control.desktopControlStatus().state).toBe('running')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(control.desktopControlStatus().state).toBe('paused')
    expect(host.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
  })
})
