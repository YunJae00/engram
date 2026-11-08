import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Placer = (next?: (views: unknown[]) => Promise<void>) => void
type State = { shown: boolean, min: boolean }
type Reaction = { calls: number[], before: State, during: State, after: State }

let app: ElectronApplication, page: Page
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const hidden: State = { shown: false, min: false }
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'minimize-restore-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'minimize-restore-data-')), ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_DEVELOPER_FIXTURE: '0' } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
})
test.afterAll(async () => { await app?.close() })

function mainState(): Promise<State & { windows: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(one => !one.webContents.getURL().endsWith('#quick'))!
    return { shown: win.isVisible(), min: win.isMinimized(), windows: BrowserWindow.getAllWindows().length }
  })
}

function readVisibility(): Promise<boolean[]> {
  return page.evaluate(() => (window as unknown as { __visibility: boolean[] }).__visibility)
}

function react(eventName: 'minimize' | 'restore', stubs: { visible: boolean, minimized: boolean }): Promise<Reaction> {
  return app.evaluate(({ BrowserWindow }, { eventName, stubs }) => {
    const win = BrowserWindow.getAllWindows().find(one => !one.webContents.getURL().endsWith('#quick'))!
    const hook = (globalThis as typeof globalThis & { __engramNativePlacer?: Placer }).__engramNativePlacer
    if (!hook) throw new Error('native placer hook missing')
    const calls: number[] = []
    hook(async views => { calls.push(Array.isArray(views) ? views.length : -1) })
    const proto = Object.getPrototypeOf(win) as typeof win
    const real = () => ({ shown: proto.isVisible.call(win), min: proto.isMinimized.call(win) })
    const before = real()
    let during = before
    try {
      win.isMinimized = () => stubs.minimized
      win.isVisible = () => stubs.visible
      win.emit(eventName)
      during = real()
    } finally {
      delete (win as unknown as Record<string, unknown>)['isMinimized']
      delete (win as unknown as Record<string, unknown>)['isVisible']
      hook()
    }
    return { calls, before, during, after: { shown: win.isVisible(), min: win.isMinimized() } }
  }, { eventName, stubs })
}

test('minimize and restore reactions run without showing the hidden window', async () => {
  const start = await mainState()
  expect({ shown: start.shown, min: start.min }).toEqual(hidden)
  await page.evaluate(() => {
    const seen: boolean[] = []
    Object.assign(window, { __visibility: seen })
    window.engram.onEvent(event => { if (event.type === 'desktop:visibility') seen.push(event.visible) })
  })

  const minimized = await react('minimize', { visible: false, minimized: true })
  expect(minimized.calls).toEqual([0])
  expect([minimized.before, minimized.during, minimized.after]).toEqual([hidden, hidden, hidden])
  await expect.poll(readVisibility).toEqual([false])

  const restored = await react('restore', { visible: true, minimized: false })
  await expect.poll(readVisibility).toEqual([false, true])
  expect(restored.calls).toEqual([])
  expect([restored.before, restored.during, restored.after]).toEqual([hidden, hidden, hidden])

  expect(await page.evaluate(() => window.engram.botsList().then(list => Array.isArray(list)))).toBe(true)
  expect(await page.evaluate(() => window.engram.desktopVisible())).toBe(false)
  const end = await mainState()
  expect(end).toEqual(start)
})
