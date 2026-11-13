import { beforeEach, expect, it, vi } from 'vitest'

interface FakeWindow { window: string; pid: number; title: string; minimized: boolean; hidden?: boolean; protected?: boolean; barrier?: string }
const fake = vi.hoisted(() => ({
  windows: [] as FakeWindow[], launchWindow: undefined as FakeWindow | undefined, preview: vi.fn(),
  unhide: undefined as undefined | (() => Promise<unknown>),
  request: vi.fn(),
}))
vi.mock('electron', () => ({ screen: {}, BrowserWindow: { getAllWindows: () => [] }, desktopCapturer: { getSources: vi.fn() } }))
vi.mock('../src/main/desktop-host.js', () => ({
  DesktopHost: class { static available() { return true } closed = false; close() { this.closed = true } request = fake.request },
}))
vi.mock('../src/main/agent-browser.js', () => ({ agentBrowserPids: async () => [] }))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: fake.preview }))
vi.mock('../src/main/desktop-overlay.js', () => ({ hideControlOverlay: vi.fn(), overlayPointer: vi.fn(), prepareControlOverlay: vi.fn(), updateControlOverlay: vi.fn() }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { endDesktopTurn, openDesktopApp, setDesktopEngineResolver, stopDesktopFromUi } from '../src/main/desktop-control.js'
import { closeDesktopAccess, desktopBinding, desktopRestoring, releaseDesktop } from '../src/main/desktop-access.js'

const lane = 'bot-signin'
const login: FakeWindow = { window: '500', pid: 500, title: 'KakaoTalk', minimized: false, protected: true, barrier: 'This application surface requires manual control (window: 로그인)' }
beforeEach(async () => {
  endDesktopTurn(lane)
  await closeDesktopAccess()
  vi.clearAllMocks()
  setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
  fake.windows = []
  fake.unhide = undefined
  fake.request.mockImplementation(async (method: string) => {
    if (method === 'listWindows') return { windows: fake.windows }
    if (method === 'openApp') {
      if (fake.launchWindow) fake.windows.push(fake.launchWindow)
      return { opened: true, windowVerified: true, hidden: true, hiddenFallback: '', window: '500', pid: 500, foregroundChanged: true, foregroundRestored: true, hiddenMs: 1159 }
    }
    if (method === 'unhideApp') return fake.unhide ? fake.unhide() : { hidden: false }
    return {}
  })
})

it('a sign-in window is shown to the person', async () => {
  fake.launchWindow = login
  await openDesktopApp(lane, '카카오톡')
  expect(fake.request).toHaveBeenCalledWith('unhideApp', { pid: 500, activate: true })
  expect(desktopBinding(lane)?.hiddenByEngram).toBeUndefined()
  await vi.waitFor(() => expect(desktopRestoring()).toBe(false))
  releaseDesktop(lane)
  expect(fake.request).not.toHaveBeenCalledWith('unhideApp', { pid: 500, activate: false })
})

it('the result says the app waits for sign-in', async () => {
  fake.launchWindow = login
  const result = JSON.parse(await openDesktopApp(lane, '카카오톡'))
  expect(result).toMatchObject({ opened: true, hidden: false, signInRequired: true, shownToPerson: true, pid: 500 })
  expect(result.hint).toContain('sign-in')
  expect(result.hint).not.toContain('stays hidden')
  expect(result.hint).not.toContain('watches the preview card')
})

it('a sign-in window that cannot be raised says so', async () => {
  fake.launchWindow = login
  fake.unhide = () => Promise.reject(new Error('host closed'))
  const result = JSON.parse(await openDesktopApp(lane, '카카오톡'))
  expect(result).toMatchObject({ signInRequired: true, shownToPerson: false })
  expect(result.hint).toContain('could not bring it to the front')
})

it('stop during the sign-in unhide rejects the open', async () => {
  fake.launchWindow = login
  let done!: () => void
  fake.unhide = () => new Promise(resolve => { done = () => resolve({ hidden: false }) })
  const pending = openDesktopApp(lane, '카카오톡')
  const rejected = expect(pending).rejects.toThrow('Computer control stopped:')
  await vi.waitFor(() => expect(done).toBeTypeOf('function'))
  stopDesktopFromUi()
  done()
  await rejected
})

it('a normal hidden launch stays hidden', async () => {
  fake.launchWindow = { window: '500', pid: 500, title: 'Calculator', minimized: false, hidden: true }
  const result = JSON.parse(await openDesktopApp(lane, 'calculator'))
  expect(result.hidden).toBe(true)
  expect(result.signInRequired).toBeUndefined()
  expect(result.hint).toContain('stays hidden')
  expect(fake.request).not.toHaveBeenCalledWith('unhideApp', expect.anything())
  expect(desktopBinding(lane)?.hiddenByEngram).toBe(500)
})

it('an app already open at its sign-in window is shown and said to wait for sign-in', async () => {
  fake.launchWindow = undefined
  fake.windows = [login]
  const result = JSON.parse(await openDesktopApp(lane, 'KakaoTalk'))
  expect(fake.request).not.toHaveBeenCalledWith('openApp', expect.anything())
  expect(fake.request).toHaveBeenCalledWith('unhideApp', { pid: 500, activate: true })
  expect(result).toMatchObject({ alreadyOpen: true, hidden: false, signInRequired: true, shownToPerson: true, pid: 500 })
  expect(result.hint).toContain('sign-in')
  expect(result.hint).not.toContain('stays hidden')
})

it('stop while an already-open sign-in window is shown rejects the open', async () => {
  fake.launchWindow = undefined
  fake.windows = [login]
  let done!: () => void
  fake.unhide = () => new Promise(resolve => { done = () => resolve({ hidden: false }) })
  const pending = openDesktopApp(lane, 'KakaoTalk')
  const rejected = expect(pending).rejects.toThrow('Computer control stopped:')
  await vi.waitFor(() => expect(done).toBeTypeOf('function'))
  stopDesktopFromUi()
  done()
  await rejected
})
