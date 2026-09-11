import { describe, expect, it, vi } from 'vitest'
import type { DesktopBinding } from '../src/main/desktop-access.js'
import { binding, binds, control, deps, grants, lane, other, status } from './desktop-control-fixture.js'

describe('taking the computer', () => {
  it('refreshes an expired planned click and uses the fresh snapshot', async () => {
    const host = binding()
    const read = await control.readControlledDesktop(lane, undefined, true)
    vi.setSystemTime(new Date('2026-01-01T00:00:20Z'))
    await control.actOnDesktop(lane, { kind: 'click', snapshot: read.snapshot, element: 'e0' })
    expect(host.request).toHaveBeenCalledWith('click', expect.objectContaining({ snapshot: 'snapshot-2', element: 'e0' }))
  })
  it('does not send a delayed key when focus cannot be revalidated', async () => {
    const host = binding()
    const read = await control.readControlledDesktop(lane, undefined, true)
    vi.setSystemTime(new Date('2026-01-01T00:00:20Z'))
    await expect(control.actOnDesktop(lane, { kind: 'key', snapshot: read.snapshot, key: 'Enter' })).rejects.toThrow('Keyboard focus changed')
    expect(host.request.mock.calls.some(([method]) => method === 'key')).toBe(false)
  })
  it('releases input but keeps the overlay through the desktop loop without discarding the snapshot', async () => {
    const host = binding()
    const read = await control.withDesktopActivity(lane, () => control.readControlledDesktop(lane, undefined, true))
    expect(host.request).toHaveBeenLastCalledWith('idle', { window: '100', pid: 200, lease: 'native-100' })
    expect(control.desktopControlStatus()).toMatchObject({ state: 'running', inputActive: false })
    expect(deps.overlay.hide).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.request.mock.calls.filter(([method]) => method === 'work')).toHaveLength(0)
    await control.withDesktopActivity(lane, () => control.actOnDesktop(lane, { kind: 'click', snapshot: read.snapshot, element: 'e0' }))
    expect(host.request).toHaveBeenCalledWith('work', { window: '100', pid: 200, lease: 'native-100', overlay: '900' })
    expect(grants(host.request)).toHaveLength(1)
    expect(control.desktopControlStatus()).toMatchObject({ state: 'running', inputActive: false })
    control.endDesktopTurn(lane)
    expect(deps.overlay.hide).toHaveBeenCalled()
  })

  it('waits for input release before starting another queued desktop tool', async () => {
    const host = binding()
    let release!: () => void
    const original = host.request.getMockImplementation()!
    host.request.mockImplementation(async (method, args) => {
      if (method === 'idle') await new Promise<void>((resolve) => { release = resolve })
      return original(method, args)
    })
    const first = control.withDesktopActivity(lane, () => control.readControlledDesktop(lane, undefined, true))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const run = vi.fn(async () => 'next')
    const next = control.withDesktopActivity(lane, run)
    await Promise.resolve()
    expect(run).not.toHaveBeenCalled()
    release()
    await first
    await expect(next).resolves.toBe('next')
    expect(run).toHaveBeenCalledOnce()
  })

  it('cannot start native control after Stop while the overlay is loading', async () => {
    const host = binding()
    let ready!: (handle: string) => void
    deps.overlay.prepare.mockImplementation(() => new Promise<string>((resolve) => { ready = resolve }))
    const pending = control.withDesktopActivity(lane, () => control.readControlledDesktop(lane, undefined, true))
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'))
    control.stopDesktopFromUi()
    ready('900')
    await rejected
    expect(grants(host.request)).toHaveLength(0)
    expect(deps.overlay.hide).toHaveBeenCalled()
  })

  it('releases the native hold when a screenshot tool fails after taking control', async () => {
    const host = binding()
    await expect(control.withDesktopActivity(lane, async () => {
      await control.readControlledDesktop(lane, undefined, true)
      throw new Error('Screenshot validation failed')
    })).rejects.toThrow('Screenshot validation failed')
    expect(host.request).toHaveBeenLastCalledWith('idle', expect.objectContaining({ lease: 'native-100' }))
    expect(control.desktopControlStatus()).toMatchObject({ state: 'running', inputActive: false })
  })

  it('preserves an activation error but allows a fresh observation without cancelling the turn', async () => {
    const host = binding()
    host.request.mockImplementation(async (method) => {
      if (method === 'bind') return { lease: 'native-100' }
      if (method === 'observe') throw new Error('The app did not acknowledge foreground activation')
      if (method === 'inputState') return { idleMs: 5000, escaped: false }
      return { ok: true }
    })
    await expect(control.readControlledDesktop(lane, undefined, true)).rejects.toThrow('foreground activation')
    expect(control.desktopControlStatus()).toMatchObject({ resumable: true, reason: 'The app did not acknowledge foreground activation' })
    expect(() => control.assertDesktopTurnNotStopped(lane)).not.toThrow()
    const retry = control.readControlledDesktop(lane, undefined, true)
    const rejected = expect(retry).rejects.toThrow('foreground activation')
    control.resumeDesktopControl()
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(host.request.mock.calls.filter(([method]) => method === 'bind')).toHaveLength(2)
  })
  it('retries a transient activation interruption with a fresh grant after input is idle', async () => {
    const host = binding()
    const run = host.request.getMockImplementation()!
    let interrupted = false
    host.request.mockImplementation(async (...args) => {
      if (args[0] === 'bind' && !interrupted) {
        interrupted = true
        throw new Error('Keyboard input returned control to the user')
      }
      if (args[0] === 'inputState') return { idleMs: 5000, escaped: false }
      return run(...args)
    })
    const read = control.readControlledDesktop(lane, undefined, true)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await read).snapshot).toBe('snapshot-1')
    const grants = host.request.mock.calls.filter(([method]) => method === 'bind').map(([, args]) => args.grant)
    expect(grants).toHaveLength(2)
    expect(new Set(grants).size).toBe(2)
  })
  it('the first reading takes control: no dialog, the overlay is told who holds it', async () => {
    const host = binding()
    const read = await control.readControlledDesktop(lane, undefined, true)
    expect(read.snapshot).toBe('snapshot-1')
    expect(host.request).toHaveBeenCalledWith('bind', { window: '100', pid: 200, grant: expect.any(String), overlay: '900' })
    expect(host.request).toHaveBeenCalledWith('observe', { window: '100', pid: 200, lease: 'native-100' })
    expect(host.value.readable).toBe(true)
    expect(control.desktopControlStatus()).toMatchObject({ state: 'running', lane, name: 'Editor', engine: 'claude', engineLabel: 'Claude' })
    expect(deps.overlay.prepare).toHaveBeenCalledOnce()
    expect(status()).toMatchObject({ state: 'running', engineLabel: 'Claude' })
  })

  it('refuses a brain without an isolated tool session before touching anything', async () => {
    const host = binding()
    control.setDesktopEngineResolver(async () => ({ id: 'codex', desktopToolIsolation: false }))
    await expect(control.readControlledDesktop(lane, undefined, true)).rejects.toThrow('isolated tool session')
    expect(host.request).not.toHaveBeenCalled()
    expect(binds()).toBe(0)
    expect(control.desktopControlStatus().state).toBe('idle')
  })

  it('one chat holds the computer at a time', async () => {
    binding()
    binding(other, '101')
    await control.readControlledDesktop(lane, undefined, true)
    await expect(control.readControlledDesktop(other, undefined, true)).rejects.toThrow('Another chat is using the computer')
    expect(control.desktopControlStatus()).toMatchObject({ state: 'running', lane })
  })

  it('naming another app re-takes control there and releases the first hold', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    const read = await control.readControlledDesktop(lane, undefined, true, 'Sheet')
    expect(deps.bind).toHaveBeenLastCalledWith(lane, { app: 'Sheet' })
    expect(host.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
    expect(read.snapshot).toBe('snapshot-1')
    expect(control.desktopControlStatus()).toMatchObject({ state: 'running', name: 'Sheet' })
  })

  it('a manual read without agent intent never binds', async () => {
    const host = binding()
    host.value.readable = true
    await control.readControlledDesktop(lane, undefined, false)
    expect(host.request).toHaveBeenCalledExactlyOnceWith('observe', { window: '100', pid: 200 })
    expect(control.desktopControlStatus().state).toBe('idle')
  })
})

describe('the person\'s hands', () => {
  it('Stop cancels an already waiting automatic resume', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    deps.release!(lane, 'Mouse input returned control to the user')
    const pending = control.readControlledDesktop(lane, undefined, true)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(500)
    control.stopDesktopFromUi()
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(grants(host.request)).toHaveLength(1)
  })

  it('keyboard activity prevents resume even when the pointer is still', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    deps.release!(lane, 'Keyboard input returned control to the user')
    const original = host.request.getMockImplementation()!
    host.request.mockImplementation((method, args) => method === 'inputState' ? Promise.resolve({ idleMs: 100, escaped: false }) : original(method, args))
    const abort = new AbortController()
    const pending = control.readControlledDesktop(lane, abort.signal, true)
    const rejected = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(6000)
    expect(grants(host.request)).toHaveLength(1)
    abort.abort()
    await vi.advanceTimersByTimeAsync(500)
    await rejected
  })

  it('Escape during a hands-on pause prevents rearming', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    deps.release!(lane, 'Mouse input returned control to the user')
    const original = host.request.getMockImplementation()!
    host.request.mockImplementation((method, args) => method === 'inputState' ? Promise.resolve({ idleMs: 5000, escaped: true }) : original(method, args))
    const pending = control.readControlledDesktop(lane, undefined, true)
    const rejected = expect(pending).rejects.toThrow('took the computer back')
    await vi.advanceTimersByTimeAsync(500)
    await rejected
    expect(grants(host.request)).toHaveLength(1)
  })

  it('Stop while choosing the app prevents a late native bind', async () => {
    const host = binding()
    let resolve!: (value: DesktopBinding) => void
    deps.bind.mockReturnValueOnce(new Promise<DesktopBinding>((done) => { resolve = done }))
    const pending = control.readControlledDesktop(lane, undefined, true)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await vi.advanceTimersByTimeAsync(1)
    control.stopDesktopFromUi()
    resolve(host.value)
    await rejected
    expect(grants(host.request)).toHaveLength(0)
  })

  it('a hand on the mouse pauses; the comet resumes with a fresh grant once the mouse is still', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    deps.release!(lane, 'Mouse input returned control to the user')
    expect(control.desktopControlStatus()).toMatchObject({ state: 'paused', resumable: true, engineLabel: 'Claude' })
    expect(deps.overlay.update).toHaveBeenCalled()
    expect(host.value.readable).toBe(true)
    const next = control.readControlledDesktop(lane, undefined, true)
    deps.cursor = { x: 40, y: 40 }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(grants(host.request)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4_500)
    await expect(next).resolves.toMatchObject({ snapshot: 'snapshot-2' })
    const issued = grants(host.request)
    expect(issued).toHaveLength(2)
    expect(issued[0]).not.toBe(issued[1])
    expect(control.desktopControlStatus().state).toBe('running')
  })

  it('a moving mouse keeps the comet waiting, and Resume now ends the wait', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    deps.release!(lane, 'Keyboard input returned control to the user')
    const next = control.readControlledDesktop(lane, undefined, true)
    for (let step = 0; step < 20; step++) { deps.cursor = { x: step, y: step }; await vi.advanceTimersByTimeAsync(250) }
    expect(grants(host.request)).toHaveLength(1)
    control.resumeDesktopControl()
    await vi.advanceTimersByTimeAsync(300)
    await expect(next).resolves.toBeDefined()
    expect(grants(host.request)).toHaveLength(2)
  })

  it('Esc ends control for the turn: the next call asks instead of resuming', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    deps.release!(lane, 'Escape pressed')
    expect(control.desktopControlStatus()).toMatchObject({ state: 'paused', resumable: false })
    expect(deps.overlay.hide).toHaveBeenCalled()
    await expect(control.readControlledDesktop(lane, undefined, true)).rejects.toThrow('took the computer back')
    expect(grants(host.request)).toHaveLength(1)
  })

  it('repeated Stop never clears the turn cancellation', async () => {
    binding()
    await control.readControlledDesktop(lane, undefined, true)
    control.stopDesktopFromUi()
    expect(control.desktopControlStatus()).toMatchObject({ state: 'paused', resumable: false })
    control.stopDesktopFromUi()
    expect(control.desktopControlStatus().state).toBe('idle')
    await expect(control.readControlledDesktop(lane, undefined, true)).rejects.toThrow('took the computer back')
  })

  it('a bind refused while a key is held is retried after stillness, not reported as failure', async () => {
    const host = binding()
    const original = host.request.getMockImplementation()!
    let refused = false
    host.request.mockImplementation(async (method, args) => {
      if (method === 'bind' && !refused) { refused = true; throw new Error('Release your keyboard and mouse before allowing control') }
      return original(method, args)
    })
    const read = control.readControlledDesktop(lane, undefined, true)
    await vi.advanceTimersByTimeAsync(4_600)
    await expect(read).resolves.toMatchObject({ snapshot: 'snapshot-1' })
    expect(grants(host.request)).toHaveLength(2)
  })
})

describe('the turn', () => {
  it('ending the turn drops the native hold and the overlay but keeps the app connected', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    control.endDesktopTurn(lane)
    expect(host.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
    expect(host.close).not.toHaveBeenCalled()
    expect(host.value.readable).toBe(true)
    expect(control.desktopControlStatus().state).toBe('idle')
    expect(deps.overlay.hide).toHaveBeenCalled()
    await control.readControlledDesktop(lane, undefined, true)
    expect(grants(host.request)).toHaveLength(2)
  })

  it('ending another lane\'s turn leaves the holder alone', async () => {
    binding()
    await control.readControlledDesktop(lane, undefined, true)
    control.endDesktopTurn(other)
    expect(control.desktopControlStatus()).toMatchObject({ state: 'running', lane })
  })
})

describe('acting', () => {
  it('requires the latest unconsumed snapshot and reports where the hand went', async () => {
    const host = binding()
    const first = await control.readControlledDesktop(lane, undefined, true)
    const latest = await control.readControlledDesktop(lane, undefined, true)
    await expect(control.actOnDesktop(lane, { kind: 'click', snapshot: first.snapshot, element: 'e0' })).rejects.toThrow('stale')
    host.request.mockImplementationOnce(async () => {
      expect(deps.overlay.pointer).not.toHaveBeenCalled()
      deps.cursor = { x: -809, y: 44 }
      return { ok: true }
    })
    await control.actOnDesktop(lane, { kind: 'click', snapshot: latest.snapshot, x: 1, y: 0 })
    expect(host.request).toHaveBeenCalledWith('click', { window: '100', pid: 200, lease: 'native-100', snapshot: latest.snapshot, x: -809, y: 44 })
    expect(deps.overlay.pointer).toHaveBeenCalledWith({ x: -809, y: 44 }, true)
    await expect(control.actOnDesktop(lane, { kind: 'click', snapshot: latest.snapshot, x: 1, y: 0 })).rejects.toThrow('stale')
  })

  it('does not expose typing text through its result, status or change notifications', async () => {
    const host = binding()
    const read = await control.readControlledDesktop(lane, undefined, true)
    const text = 'private document content'
    const result = await control.actOnDesktop(lane, { kind: 'type', snapshot: read.snapshot, text })
    expect(host.request).toHaveBeenCalledWith('type', expect.objectContaining({ text }))
    expect(result).toContain('verify the outcome')
    expect(JSON.stringify([result, control.desktopControlStatus(), deps.changed.mock.calls, deps.broadcast.mock.calls])).not.toContain(text)
  })

  it('live document access uses the same window lease and cannot bypass Stop', async () => {
    const host = binding()
    await control.accessLiveDocument(lane, 'documentRead', { range: 'A1:D5' })
    expect(host.request).toHaveBeenCalledWith('documentRead', { window: '100', pid: 200, lease: 'native-100', range: 'A1:D5' })
    control.stopDesktopFromUi()
    const count = host.request.mock.calls.length
    await expect(control.accessLiveDocument(lane, 'documentEdit', { snapshot: 'previous', edits: [] })).rejects.toThrow(/cancelled|stopped|Esc/i)
    expect(host.request.mock.calls).toHaveLength(count)
  })

  it('an action that fails ends control without a resume', async () => {
    const host = binding()
    const read = await control.readControlledDesktop(lane, undefined, true)
    host.request.mockRejectedValueOnce(new Error('Native failure'))
    await expect(control.actOnDesktop(lane, { kind: 'click', snapshot: read.snapshot, element: 'e0' })).rejects.toThrow('Native failure')
    expect(control.desktopControlStatus()).toMatchObject({ state: 'paused', resumable: false })
    expect(host.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
    expect(deps.overlay.pointer).not.toHaveBeenCalled()
  })

  it('a cancelled turn releases the native hold at once', async () => {
    const host = binding()
    await control.readControlledDesktop(lane, undefined, true)
    const gate = new Promise<unknown>(() => undefined)
    const signal = new AbortController()
    host.request.mockReturnValueOnce(gate)
    const read = control.readControlledDesktop(lane, signal.signal, true)
    const rejected = expect(read).rejects.toThrow()
    signal.abort(new Error('Chat cancelled'))
    expect(control.desktopControlStatus().state).toBe('paused')
    expect(host.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
    await rejected
  })
})
