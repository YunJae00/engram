import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBinding } from '../src/main/desktop-access.js'
import type { Engine } from 'core'

type Choice = Pick<Engine, 'id' | 'desktopToolIsolation'>
const fake = vi.hoisted(() => ({ binding: undefined as DesktopBinding | undefined, dialog: vi.fn(), engine: vi.fn(), changed: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showMessageBox: fake.dialog } }))
vi.mock('../src/main/desktop-access.js', () => ({
  desktopBinding: () => fake.binding, desktopOwner: () => 'main-owner', desktopChanged: fake.changed,
  bindDesktopForLane: async () => { fake.binding!.readable = true; return fake.binding },
  setDesktopReleaseHook: vi.fn(),
}))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/desktop-overlay.js', () => ({ prepareControlOverlay: vi.fn().mockResolvedValue('900'), updateControlOverlay: vi.fn(), hideControlOverlay: vi.fn(), overlayPointer: vi.fn() }))
let control: typeof import('../src/main/desktop-control.js')
const good: Choice = { id: 'claude', desktopToolIsolation: true }
const unsupported: Choice = { id: 'codex', desktopToolIsolation: false }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  fake.dialog.mockResolvedValue({ response: 1 })
  fake.engine.mockResolvedValue(good)
  fake.binding = { lane: 'bot-one', name: 'Fixture', source: 'window:100:0', window: '100', pid: 200, readable: false, stopped: false, revision: 0,
    host: { closed: false, close: vi.fn(), request: vi.fn(async (method: string) => method === 'bind' ? { lease: 'native' } : { snapshot: 's', nodes: [], bounds: { x: 0, y: 0, width: 10, height: 10 } }) } as unknown as DesktopBinding['host'] }
  control = await import('../src/main/desktop-control.js')
  control.setDesktopEngineResolver(fake.engine)
})
afterEach(() => control.stopDesktopControl('Test cleanup'))

describe('desktop connection isolation capability gate', () => {
  it.each([undefined, unsupported, { id: 'claude' }, { id: 'claude', desktopToolIsolation: false }])('does not show consent or arm unsupported connection %#', async (engine) => {
    fake.engine.mockResolvedValue(engine)
    await expect(control.startDesktopControl('bot-one')).rejects.toThrow('cannot safely run selected-app tools')
    expect(control.desktopControlStatus().state).toBe('idle')
    expect(fake.dialog).not.toHaveBeenCalled()
    expect(fake.binding!.host.request).not.toHaveBeenCalled()
    expect(fake.binding!.readable).toBe(false)
  })

  it('rejects a connection that becomes unsupported during resolution', async () => {
    const answer = deferred<Choice>()
    fake.engine.mockReturnValueOnce(answer.promise)
    const pending = control.startDesktopControl('bot-one')
    const rejected = expect(pending).rejects.toThrow('cannot safely run selected-app tools')
    answer.resolve(unsupported)
    await rejected
    expect(control.desktopControlStatus().state).toBe('idle')
    expect(fake.binding!.host.request).not.toHaveBeenCalled()
    expect(fake.binding!.readable).toBe(false)
  })

  it('does not resurrect a grant after Stop during the connection check', async () => {
    const engine = deferred<Choice>()
    fake.engine.mockReturnValueOnce(engine.promise)
    const pending = control.startDesktopControl('bot-one')
    const rejected = expect(pending).rejects.toThrow('cancelled')
    control.stopDesktopForLane('bot-one')
    engine.resolve(good)
    await rejected
    expect(fake.dialog).not.toHaveBeenCalled()
    expect(control.desktopControlStatus().state).toBe('idle')
  })

  it('does not let a stale connection check cancel a fresh same-lane grant', async () => {
    const engine = deferred<Choice>()
    fake.engine.mockReturnValueOnce(engine.promise)
    const pending = control.startDesktopControl('bot-one')
    const rejected = expect(pending).rejects.toThrow('cancelled')
    control.stopDesktopForLane('bot-one')
    engine.resolve(good)
    await rejected
    await control.startDesktopControl('bot-one')
    expect(control.desktopControlStatus().state).toBe('running')
  })

  it.each([unsupported, { id: 'mock', desktopToolIsolation: true }])('rejects a turn with a different connection %# before native binding', async (engine) => {
    await control.startDesktopControl('bot-one')
    expect(() => control.assertDesktopChatEngine('bot-one', engine as Choice)).toThrow('cannot safely run selected-app tools')
    expect(control.desktopControlStatus().state).toBe('paused')
    expect(fake.binding!.host.request).toHaveBeenCalledWith('stop', { lease: 'native' })
  })

  it('revokes a bound native lease when an unsupported turn attempts to use it', async () => {
    await control.startDesktopControl('bot-one')
    await control.readControlledDesktop('bot-one', undefined, true)
    expect(() => control.assertDesktopChatEngine('bot-one', unsupported)).toThrow()
    expect(fake.binding!.host.request).toHaveBeenCalledWith('stop', { lease: 'native' })
  })

  it('keeps preview and manual reads available with an unsupported connection', async () => {
    expect(() => control.assertDesktopChatEngine('bot-one', unsupported)).not.toThrow()
    fake.binding!.readable = true
    await expect(control.readControlledDesktop('bot-one')).resolves.toMatchObject({ snapshot: 's' })
    expect(() => control.assertDesktopChatEngine('bot-one', unsupported)).toThrow()
    expect(fake.binding!.readable).toBe(true)
    expect(fake.binding!.host.request).toHaveBeenCalledExactlyOnceWith('observe', { window: '100', pid: 200 })
  })

  it('allows the explicitly supported connection for the granted turn', async () => {
    await control.startDesktopControl('bot-one')
    expect(() => control.assertDesktopChatEngine('bot-one', good)).not.toThrow()
    expect(control.desktopControlStatus().state).toBe('running')
  })
})
