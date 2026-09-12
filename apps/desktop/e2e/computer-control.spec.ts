import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopControlStatusDto } from '../src/shared/desktop.js'

// The computer is taken by the comet, not chosen by the person: there is no
// window picker anywhere, and the only controls a person meets are the banner
// that names the brain at work and the way to take the computer back.

interface DesktopMock { available: boolean; control: DesktopControlStatusDto; stops: number; resumes: number }
type MockGlobal = typeof globalThis & { desktopMock: DesktopMock }
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-computer-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-computer-userdata-')),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const state: DesktopMock = { available: true, control: { state: 'idle' }, stops: 0, resumes: 0 }
    ipcMain.removeHandler('engines:list')
    ipcMain.handle('engines:list', () => [{ id: 'claude', installed: true, loggedIn: true, desktopToolIsolation: true }])
    ;(globalThis as MockGlobal).desktopMock = state
    const tell = () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'desktop:control', control: state.control }) }
    const install = (name: string, handler: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(`desktop:${name}`)
      ipcMain.handle(`desktop:${name}`, (_event, ...args: unknown[]) => handler(...args))
    }
    install('available', () => state.available)
    install('visible', () => false)
    install('windows', () => [])
    install('bindings', () => [])
    install('controlStatus', () => state.control)
    install('overlayStatus', () => state.control)
    install('controlStop', () => {
      state.stops++
      state.control = state.control.state === 'paused' ? { state: 'idle' } : { ...state.control, state: 'paused', resumable: false }
      tell()
    })
    install('controlResume', () => { state.resumes++ })
    install('prepare', () => { throw new Error('Native capture is disabled in this fixture.') })
    install('cancelCapture', () => true)
    tell()
  })
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  const ids = await page.evaluate(async () => {
    const ids: string[] = []
    for (const name of ['Computer review', 'Planning review']) ids.push((await window.engram.botCreate({ name, purpose: 'Review the spreadsheet' })).id)
    localStorage.setItem('engram.mission.slots', JSON.stringify(ids))
    return ids
  })
  expect(ids).toHaveLength(2)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
})

test.afterAll(async () => { await app?.close() })

test('the overlay pill renders and its resume and stop buttons reach the host', async () => {
  await control({ state: 'paused', lane: 'bot-one', engine: 'claude', engineLabel: 'Claude', resumable: true })
  const url = page.url().split('#')[0]! + '#overlay-pill'
  const nextWindow = app.waitForEvent('window')
  await app.evaluate(async ({ BrowserWindow }, { target, preload }) => {
    const overlay = new BrowserWindow({ show: false, frame: false, autoHideMenuBar: true, width: 480, height: 80, webPreferences: {
      preload, contextIsolation: true, nodeIntegration: false, sandbox: false,
    } })
    await overlay.loadURL(target)
  }, { target: url, preload: fileURLToPath(new URL('../out/preload/index.mjs', import.meta.url)) })
  const overlay = await nextWindow
  try {
    await expect(overlay.getByTestId('control-pill')).toContainText('You took over')
    await overlay.getByTestId('overlay-resume').click()
    await expect.poll(() => app.evaluate(() => (globalThis as MockGlobal).desktopMock.resumes)).toBe(1)
    await control({ state: 'running', lane: 'bot-one', engine: 'claude', engineLabel: 'Claude' })
    await expect(overlay.getByTestId('control-pill')).toContainText('Comets using your computer')
    await control({ state: 'running', lane: 'bot-one', engine: 'claude', engineLabel: 'Claude', inputActive: false })
    await expect(overlay.getByTestId('control-pill')).toContainText('Planning the next move')
    await control({ state: 'running', lane: 'bot-one', inputActive: false, application: { name: 'PowerPoint', bounds: { x: 100, y: 100, width: 800, height: 600 }, visible: true } })
    await expect(overlay.getByTestId('control-pill')).toContainText('Comets at work · PowerPoint')
    await expect(overlay.getByTestId('control-pill')).toContainText('Your mouse stays yours')
    await overlay.screenshot({ path: join(TMP, 'comets-control-pill.png') })
    await expect(overlay.getByTestId('control-pill')).not.toContainText('controlling your computer')
    await control({ state: 'running', lane: 'bot-one', engine: 'claude', engineLabel: 'Claude' })
    await expect(overlay.getByTestId('control-pill')).toContainText('Comets using your computer')
    await overlay.getByTestId('overlay-stop').click()
    await expect.poll(() => app.evaluate(() => (globalThis as MockGlobal).desktopMock.stops)).toBe(1)
    await expect(overlay.locator('.control-pill-stage')).toHaveCSS('opacity', '0')
    await expect(overlay.getByTestId('overlay-stop')).toBeDisabled()
  } finally { await overlay.close() }
})
test.beforeEach(async () => {
  await app.evaluate(() => {
    const mock = (globalThis as MockGlobal).desktopMock
    Object.assign(mock, { available: true, control: { state: 'idle' }, stops: 0, resumes: 0 })
  })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
})

test('application glow follows its window and pointer movement has no ghost copies', async () => {
  const nextWindow = app.waitForEvent('window')
  await app.evaluate(async ({ BrowserWindow }, { target, preload }) => {
    const surface = new BrowserWindow({ show: false, frame: false, width: 1000, height: 750, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false } })
    await surface.loadURL(target)
  }, { target: page.url().split('#')[0]! + '#overlay', preload: fileURLToPath(new URL('../out/preload/index.mjs', import.meta.url)) })
  const surface = await nextWindow
  try {
    await control({ state: 'running', application: { name: 'PowerPoint', bounds: { x: 80, y: 90, width: 800, height: 600 }, visible: true } })
    const glow = surface.locator('.control-overlay-glow')
    await expect(glow).toHaveCSS('width', '800px')
    await expect(glow).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 80, 90)')
    await expect(surface.locator('.control-overlay-mark')).toHaveCount(0)
    await control({ state: 'running', engine: 'claude' })
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('engram:event', { type: 'desktop:pointer', x: 100, y: 200 })
        win.webContents.send('engram:event', { type: 'desktop:pointer', x: 200, y: 300, press: true })
      }
    })
    await expect(surface.locator('.control-overlay-mark')).toHaveCount(1)
    await expect(surface.locator('.control-overlay-ghost')).toHaveCount(0)
    await expect(surface.locator('.control-overlay-mark')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 214, 312)')
    await control({ state: 'idle' })
    await expect(surface.locator('.control-overlay-glow')).toHaveCSS('opacity', '0')
  } finally { await surface.close() }
})

async function state() { return app.evaluate(() => (globalThis as MockGlobal).desktopMock) }
async function control(next: DesktopControlStatusDto) {
  await app.evaluate(({ BrowserWindow }, status) => {
    ;(globalThis as MockGlobal).desktopMock.control = status
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'desktop:control', control: status })
  }, next)
}
async function orbit() {
  if (!await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId('activity-mission').click()
  await page.getByTestId('mission-layout-2').click()
}

test('no picker anywhere: the tiles show pages, the composer has no computer switch', async () => {
  await orbit()
  for (const index of [0, 1]) {
    const tile = page.getByTestId(`mission-tile-${index}`)
    await expect(tile.getByTestId('orbit-surface')).toBeVisible()
    await expect(tile.getByRole('button', { name: 'Computer', exact: true })).toHaveCount(0)
    await expect(tile.getByRole('button', { name: 'Choose an app window', exact: true })).toHaveCount(0)
  }
  await page.getByTestId('mission-tile-0').locator('.mission-enter').click()
  await expect(page.getByTestId('composer-computer')).toHaveCount(0)
  await expect(page.getByTestId('desktop-chat-pane')).toHaveCount(0)
  await expect(page.getByTestId('computer-control-status')).toHaveCount(0)
})

test('control stays out of the app even after Esc takes it back', async () => {
  await orbit()
  await control({ state: 'running', lane: 'bot-one', name: 'Excel', engine: 'claude', engineLabel: 'Claude' })
  const banner = page.getByTestId('computer-control-status')
  await expect(banner).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await state()).stops).toBe(1)
  await expect(banner).toHaveCount(0)
  expect((await state()).control).toMatchObject({ state: 'paused', resumable: false })
  await page.keyboard.press('Escape')
  expect((await state()).stops).toBe(1)
})

test('terminal errors never add an in-app banner or bottom space at any width', async () => {
  await orbit()
  await control({ state: 'paused', lane: 'bot-one', engine: 'claude', engineLabel: 'Claude', resumable: true })
  const banner = page.getByTestId('computer-control-status')
  await expect(banner).toHaveCount(0)
  await control({ state: 'paused', lane: 'bot-one', name: 'Excel', engine: 'claude', engineLabel: 'Claude', resumable: false, reason: 'The app could not be read.' })
  await mkdir(join(TMP, 'desktop-control-ui'), { recursive: true })
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 })
    if (width <= 900 && await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-close').click()
    await expect(banner).toHaveCount(0)
    await expect(page.getByTestId('computer-control-stop')).toHaveCount(0)
    await expect(page.getByTestId('shell')).toHaveCSS('padding-bottom', '0px')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0]!
      const image = await main.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      if (image.isEmpty()) throw new Error('The hidden fixture did not render a frame')
      return image.toPNG().toString('base64')
    })
    await writeFile(join(TMP, 'desktop-control-ui', `electron-orbit-${width}.png`), Buffer.from(png, 'base64'))
  }
  await page.setViewportSize({ width: 1440, height: 900 })
})

test('settings carry one switch for computer use, and its state', async () => {
  await orbit()
  await control({ state: 'running', lane: 'bot-one', name: 'Excel', engine: 'claude', engineLabel: 'Claude' })
  if (!await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId('activity-settings').click()
  await page.getByTestId('settings-nav-computer').click()
  const settings = page.getByTestId('computer-settings')
  await expect(settings).toContainText('Control apps')
  await expect(settings).not.toContainText('select a window')
  const toggle = page.getByTestId('setting-computer-use')
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(settings).toContainText('Claude is controlling your computer')
  await expect(page.getByTestId('computer-control-status')).toHaveCount(0)
  expect(await settings.evaluate((box) => box.getBoundingClientRect().bottom <= innerHeight)).toBe(true)
  await toggle.uncheck()
  await expect.poll(() => page.evaluate(() => window.engram.settingsGet().then((value) => value.computerUse))).toBe(false)
  await control({ state: 'idle' })
  await expect(settings).toContainText('Off')
  await toggle.check()
  await expect.poll(() => page.evaluate(() => window.engram.settingsGet().then((value) => value.computerUse))).toBe(true)
  await expect(settings).toContainText('Ready')
})
