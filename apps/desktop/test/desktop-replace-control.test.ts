import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopBinding } from '../src/main/desktop-access.js'
import type { DesktopMethod } from '../src/main/desktop-host.js'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({ binding: undefined as DesktopBinding | undefined, request: vi.fn(), overlay: vi.fn() }))
vi.mock('electron', () => ({ screen: { getCursorScreenPoint: () => ({ x: 10, y: 10 }) } }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopBinding: () => fake.binding, bindDesktopForLane: async () => fake.binding,
  desktopChanged: () => undefined, setDesktopReleaseHook: () => undefined }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: () => undefined }))
vi.mock('../src/main/desktop-overlay.js', () => ({ prepareControlOverlay: async () => '900', updateControlOverlay: fake.overlay,
  hideControlOverlay: fake.overlay, overlayPointer: fake.overlay }))

let control: typeof import('../src/main/desktop-control.js')
const view = (snapshot = 'first', id = 'e1', runtimeId = 'editor'): DesktopObservationDto => ({ snapshot,
  bounds: { x: 0, y: 0, width: 400, height: 300 }, focusedEditable: true, focusedControl: runtimeId,
  nodes: [{ id, runtimeId, name: 'Draft', controlType: 'Edit', value: 'Old', valueTruncated: false,
    actions: { replace: true, type: true }, bounds: { x: 10, y: 10, width: 200, height: 30 } }] })

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(0); vi.clearAllMocks()
  fake.request.mockImplementation(async (method: DesktopMethod) => method === 'bind' ? { lease: 'native-100' }
    : method === 'inputState' ? { intervention: '0', escaped: false, idleMs: 5000 }
      : method === 'observe' ? view() : { sent: true })
  fake.binding = { lane: 'bot-replace', source: 'window:100:200', name: 'Draft', window: '100', pid: 200, readable: true,
    revision: 0, stopped: false, host: { request: fake.request } } as unknown as DesktopBinding
  control = await import('../src/main/desktop-control.js')
  control.setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
})
afterEach(() => { control.stopDesktopControl(); vi.clearAllTimers(); vi.useRealTimers() })

it('sends an explicit replacement with both values and consumes the snapshot', async () => {
  await control.readControlledDesktop('bot-replace', undefined, true)
  const action = { kind: 'replace', snapshot: 'first', element: 'e1', expected: 'Old', text: 'New' } as const
  const result = await control.actOnDesktop('bot-replace', action)
  expect(fake.request).toHaveBeenCalledWith('replace', { window: '100', pid: 200, lease: 'native-100', snapshot: 'first', element: 'e1', expected: 'Old', text: 'New' })
  expect(result).toContain('verify')
  await expect(control.actOnDesktop('bot-replace', action)).rejects.toThrow('stale')
})

it.each(['value', 'runtime', 'focus'] as const)('rejects delayed replacement after %s changes', async (change) => {
  await control.readControlledDesktop('bot-replace', undefined, true)
  vi.setSystemTime(11000)
  const fresh = view('second', 'e9', change === 'runtime' ? 'new-editor' : 'editor')
  if (change === 'value') fresh.nodes[0]!.value = 'Changed'
  if (change === 'focus') fresh.focusedControl = 'different'
  fake.request.mockImplementation(async (method: DesktopMethod) => method === 'observe' ? fresh : { sent: true })
  await expect(control.actOnDesktop('bot-replace', { kind: 'replace', snapshot: 'first', element: 'e1', expected: 'Old', text: 'New' })).rejects.toThrow()
  expect(fake.request.mock.calls.some(([method]) => method === 'replace')).toBe(false)
})

it('refreshes a delayed unchanged replacement by runtime identity, not its old element number', async () => {
  await control.readControlledDesktop('bot-replace', undefined, true)
  vi.setSystemTime(11000)
  fake.request.mockImplementation(async (method: DesktopMethod) => method === 'observe' ? view('second', 'e9') : { sent: true })
  await control.actOnDesktop('bot-replace', { kind: 'replace', snapshot: 'first', element: 'e1', expected: 'Old', text: 'New' })
  expect(fake.request).toHaveBeenCalledWith('replace', expect.objectContaining({ snapshot: 'second', element: 'e9', expected: 'Old', text: 'New' }))
})
