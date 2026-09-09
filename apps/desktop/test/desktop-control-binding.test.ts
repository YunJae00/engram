import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, desktopCapturer: {}, screen: {} }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/desktop-overlay.js', () => ({
  prepareControlOverlay: vi.fn(async () => '900'), updateControlOverlay: vi.fn(), hideControlOverlay: vi.fn(), overlayPointer: vi.fn(),
}))
vi.mock('../src/main/desktop-host.js', () => ({
  DesktopHost: class {
    closed = false
    static available() { return true }
    request = fake.request
    close() { this.closed = true }
  },
}))

let control: typeof import('../src/main/desktop-control.js')
let access: typeof import('../src/main/desktop-access.js')
const lane = 'bot-notepad'
const windows = [
  { window: '100', pid: 200, title: 'Untitled - Notepad', minimized: false },
  { window: '101', pid: 201, title: 'Other notes - Notepad', minimized: false },
]
beforeEach(async () => {
  vi.resetModules()
  fake.request.mockReset().mockImplementation(async (method: string, args: Record<string, unknown>) => {
    if (method === 'listWindows') return { windows }
    if (method === 'bind') return { lease: `native-${args['window']}` }
    if (method === 'observe') return { snapshot: 's', nodes: [], bounds: { x: 0, y: 0, width: 100, height: 100 } }
    return { ok: true }
  })
  access = await import('../src/main/desktop-access.js')
  control = await import('../src/main/desktop-control.js')
  control.setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
})
afterEach(() => { control.endDesktopTurn(lane); access.closeDesktopAccess() })

it('lists two windows then binds, reads and types without cancelling its own selection', async () => {
  expect(await access.desktopWindows()).toHaveLength(2)
  const read = await control.readControlledDesktop(lane, undefined, true, 'Untitled')
  await control.actOnDesktop(lane, { kind: 'type', snapshot: read.snapshot, text: 'Engram input test' })
  expect(fake.request).toHaveBeenCalledWith('type', expect.objectContaining({ window: '100', lease: 'native-100' }))
  expect(control.desktopControlStatus()).toMatchObject({ state: 'running', lane })
  await control.readControlledDesktop(lane, undefined, true, 'Other notes')
  expect(fake.request).toHaveBeenCalledWith('stop', { lease: 'native-100' })
  expect(control.desktopControlStatus()).toMatchObject({ state: 'running', name: 'Other notes - Notepad' })
  control.stopDesktopFromUi()
  await expect(control.readControlledDesktop(lane, undefined, true)).rejects.toThrow('took the computer back')
})

it('still honours Stop during native window discovery before the first bind', async () => {
  fake.request.mockImplementationOnce(async () => {
    control.stopDesktopFromUi()
    return { windows }
  })
  await expect(control.readControlledDesktop(lane, undefined, true, 'Untitled')).rejects.toThrow('cancelled')
  expect(fake.request.mock.calls.some(([method]) => method === 'bind')).toBe(false)
})
