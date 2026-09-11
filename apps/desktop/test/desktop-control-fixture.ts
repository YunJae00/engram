import { afterEach, beforeEach, vi } from 'vitest'
import type { DesktopBinding } from '../src/main/desktop-access.js'
import type { DesktopHost, DesktopMethod } from '../src/main/desktop-host.js'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const deps = vi.hoisted(() => ({
  bindings: new Map<string, unknown>(),
  bind: vi.fn(), changed: vi.fn(), broadcast: vi.fn(),
  overlay: { show: vi.fn(), prepare: vi.fn(), update: vi.fn(), hide: vi.fn(), pointer: vi.fn() },
  cursor: { x: 10, y: 10 },
  release: undefined as ((lane: string, reason: string) => void) | undefined,
}))
vi.mock('electron', () => ({ screen: { getCursorScreenPoint: () => ({ ...deps.cursor }), screenToDipPoint: (point: { x: number; y: number }) => point } }))
vi.mock('../src/main/desktop-access.js', () => ({
  desktopBinding: (lane: string) => deps.bindings.get(lane),
  bindDesktopForLane: deps.bind,
  desktopChanged: deps.changed,
  setDesktopReleaseHook: (hook: typeof deps.release) => { deps.release = hook },
}))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: deps.broadcast }))
vi.mock('../src/main/desktop-overlay.js', () => ({
  showControlOverlay: deps.overlay.show, prepareControlOverlay: deps.overlay.prepare, updateControlOverlay: deps.overlay.update, hideControlOverlay: deps.overlay.hide, overlayPointer: deps.overlay.pointer,
}))

const lane = 'bot-first'
const other = 'bot-second'
let control: typeof import('../src/main/desktop-control.js')

function observation(snapshot = 'snapshot-1'): DesktopObservationDto {
  return { snapshot, nodes: [{ id: 'e0', name: 'Editor', controlType: 'Edit', bounds: { x: -1000, y: 20, width: 200, height: 100 } }], bounds: { x: -1000, y: 20, width: 200, height: 100 }, captureBounds: { x: -992, y: 44, width: 184, height: 68 } }
}

function binding(owner = lane, window = '100', name = 'Editor') {
  let serial = 0
  const request = vi.fn<(method: DesktopMethod, args: Record<string, unknown>) => Promise<unknown>>(async (method) => {
    if (method === 'bind') return { lease: `native-${window}` }
    if (method === 'observe') return observation(`snapshot-${++serial}`)
    if (method === 'inputState') return { idleMs: 5000, escaped: false }
    return { ok: true }
  })
  const close = vi.fn()
  const value: DesktopBinding = { lane: owner, source: `window:${window}:0`, name, window, pid: 200, readable: false, stopped: false, revision: 0, host: { request, close, closed: false } as unknown as DesktopHost }
  deps.bindings.set(owner, value)
  return { value, request, close }
}

const binds = () => deps.bind.mock.calls.length
const grants = (request: ReturnType<typeof binding>['request']) => request.mock.calls.filter(([method]) => method === 'bind').map(([, args]) => args['grant'])
const status = () => deps.broadcast.mock.calls.map(([event]) => event).filter((event) => event.type === 'desktop:control').at(-1)?.control

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  deps.bindings.clear()
  deps.cursor = { x: 10, y: 10 }
  deps.bind.mockReset().mockImplementation(async (owner: string, pick: { app?: string }) => {
    const held = deps.bindings.get(owner) as DesktopBinding | undefined
    if (!held) throw new Error('No app window is in front to work in.')
    if (pick.app && !held.name.toLowerCase().includes(pick.app.toLowerCase())) {
      const next = binding(owner, '101', pick.app)
      next.value.readable = true
      return next.value
    }
    held.readable = true
    return held
  })
  deps.changed.mockReset()
  deps.broadcast.mockReset()
  for (const spy of Object.values(deps.overlay)) spy.mockReset()
  deps.overlay.prepare.mockResolvedValue('900')
  deps.release = undefined
  control = await import('../src/main/desktop-control.js')
  control.setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
})
afterEach(() => {
  control.stopDesktopControl('Test cleanup')
  vi.clearAllTimers()
  vi.useRealTimers()
})

export { binding, binds, control, deps, grants, lane, other, status }
