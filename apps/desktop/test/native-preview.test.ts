import { beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const fake = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), page: vi.fn(), send: vi.fn(), url: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => fake.handlers.set(name, handler), on: vi.fn() }, screen: {} }))
vi.mock('../src/main/agent-browser.js', () => ({ lanePage: fake.page }))
vi.mock('../src/main/native-browser.js', () => ({ focusNativeOwner: vi.fn(), isNativePage: () => true, nativeBrowserEnabled: () => true, nativeTarget: vi.fn(), placeNativePages: vi.fn(), setNativeBrowserOwner: vi.fn() }))
import { attachNativeLayout } from '../src/main/native-layout.js'

const detach = vi.fn(async () => {})
const page = { url: fake.url, context: () => ({ newCDPSession: async () => ({ send: fake.send, detach }) }) }
const frame = {}, contents = { mainFrame: frame, on: vi.fn() }
const event = { sender: contents, senderFrame: frame }
const win = { isDestroyed: () => false, webContents: contents, on: vi.fn(), once: vi.fn() }
beforeEach(() => {
  fake.send.mockReset().mockResolvedValue({ data: 'frame' })
  fake.page.mockReset().mockReturnValue(page)
  fake.url.mockReset().mockReturnValue('https://example.com/current')
  detach.mockClear()
  attachNativeLayout(win as unknown as BrowserWindow)
})
const snapshot = () => fake.handlers.get('native:snapshot')!(event, 'bot-a')
it('returns only the current page image and detaches the capture session', async () => {
  await expect(snapshot()).resolves.toBe('data:image/jpeg;base64,frame')
  expect(detach).toHaveBeenCalledOnce()
})
it('drops an image when the same page navigates during capture', async () => {
  fake.send.mockImplementation(async () => { fake.url.mockReturnValue('https://example.com/next'); return { data: 'old-frame' } })
  await expect(snapshot()).resolves.toBeNull()
  expect(detach).toHaveBeenCalledOnce()
})
it('drops an image if a different page becomes the lane page', async () => {
  fake.send.mockImplementation(async () => { fake.page.mockReturnValue({}); return { data: 'old-frame' } })
  await expect(snapshot()).resolves.toBeNull()
})
it('does not capture for a renderer other than the main window frame', async () => {
  await expect(fake.handlers.get('native:snapshot')!({ ...event, senderFrame: {} }, 'bot-a')).resolves.toBeNull()
  expect(fake.send).not.toHaveBeenCalled()
})
