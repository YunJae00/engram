import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DesktopBindingDto, DesktopControlStatusDto } from '../src/shared/desktop.js'

interface DesktopMock {
  available: boolean
  bindings: DesktopBindingDto[]
  control: DesktopControlStatusDto
  starts: number
  stops: number
  observations: number
  captures: number
}
type MockGlobal = typeof globalThis & { desktopMock: DesktopMock }
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let lanes: string[]

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
    const state: DesktopMock = { available: true, bindings: [], control: { state: 'idle' }, starts: 0, stops: 0, observations: 0, captures: 0 }
    ipcMain.removeHandler('engines:list')
    ipcMain.handle('engines:list', () => [{ id: 'claude', installed: true, loggedIn: true, desktopToolIsolation: true }])
    ;(globalThis as MockGlobal).desktopMock = state
    const changed = () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'desktop:changed' }) }
    const install = (name: string, handler: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(`desktop:${name}`)
      ipcMain.handle(`desktop:${name}`, (_event, ...args: unknown[]) => handler(...args))
    }
    const getBinding = (lane: unknown) => {
      const binding = state.bindings.find((one) => one.lane === lane)
      if (!binding) throw new Error('Choose a window first.')
      return binding
    }
    install('available', () => state.available)
    install('visible', () => false)
    install('windows', () => [{ id: 'window:101:0', name: 'Quarterly workbook' }, { id: 'window:102:0', name: 'Planning notes' }])
    install('bindings', () => state.bindings)
    install('controlStatus', () => state.control)
    install('choose', (lane, source) => {
      const binding = { lane: String(lane), source: String(source), name: source === 'window:101:0' ? 'Quarterly workbook' : 'Planning notes', readable: false }
      state.bindings = [...state.bindings.filter((one) => one.lane !== lane), binding]
      changed(); return binding
    })
    install('release', (lane) => { state.bindings = state.bindings.filter((one) => one.lane !== lane); changed() })
    install('readAccess', (lane, enabled) => { const binding = getBinding(lane); binding.readable = enabled === true; changed(); return binding })
    install('observe', (lane) => {
      if (!getBinding(lane).readable) throw new Error('Reading is not allowed.')
      state.observations++
      return { snapshot: 'fixture', bounds: { x: 0, y: 0, width: 1200, height: 800 }, nodes: [{ id: 'heading', name: 'Quarterly plan', value: 'Review complete', controlType: 'Text', bounds: { x: 20, y: 20, width: 200, height: 30 } }] }
    })
    install('controlStart', (lane) => {
      if (['ready', 'running', 'needs-person'].includes(state.control.state)) throw new Error('Another session owns control.')
      const binding = getBinding(lane); binding.readable = true; state.starts++
      state.control = { state: 'ready', lane: String(lane), name: binding.name }
      changed(); return state.control
    })
    install('controlStop', () => {
      state.stops++
      state.control = state.control.state === 'paused' ? { state: 'idle' } : { ...state.control, state: 'paused', reason: 'You have control.' }
      for (const binding of state.bindings) binding.readable = false
      changed()
    })
    install('prepare', () => { state.captures++; throw new Error('Native capture is disabled in this fixture.') })
    install('cancelCapture', () => true)
    changed()
  })
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  lanes = await page.evaluate(async () => {
    const ids: string[] = []
    for (const name of ['Computer review', 'Planning review']) ids.push((await window.engram.botCreate({ name, purpose: 'Review the selected window' })).id)
    localStorage.setItem('engram.mission.slots', JSON.stringify(ids))
    return ids.map((id) => `bot-${id}`)
  })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
})

test.afterAll(async () => { await app?.close() })
test.beforeEach(async () => {
  await app.evaluate(() => {
    const mock = (globalThis as MockGlobal).desktopMock
    Object.assign(mock, { available: true, bindings: [], control: { state: 'idle' }, starts: 0, stops: 0, observations: 0, captures: 0 })
  })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
})

async function state() { return app.evaluate(() => (globalThis as MockGlobal).desktopMock) }
async function control(next: DesktopControlStatusDto) {
  await app.evaluate(({ BrowserWindow }, status) => {
    ;(globalThis as MockGlobal).desktopMock.control = status
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'desktop:changed' })
  }, next)
}
async function orbit() {
  if (!await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId('activity-mission').click()
  await page.getByTestId('mission-layout-2').click()
  for (const index of [0, 1]) await page.getByTestId(`mission-tile-${index}`).getByRole('button', { name: 'Computer', exact: true }).click()
}

test('window preview and reading do not grant input; control is session-scoped and globally owned', async () => {
  await orbit()
  const first = page.getByTestId('mission-tile-0')
  const second = page.getByTestId('mission-tile-1')
  await first.getByRole('button', { name: 'Choose an app window', exact: true }).click()
  await expect(first.getByRole('textbox', { name: 'Find an app window' })).toBeFocused()
  await first.getByRole('button', { name: 'Quarterly workbook', exact: true }).click()
  await expect(first.getByText('Preview only', { exact: true })).toBeVisible()
  expect((await state()).starts).toBe(0)
  expect((await state()).observations).toBe(0)
  await first.getByRole('button', { name: 'Allow reading', exact: true }).click()
  await first.getByRole('button', { name: 'Read window text', exact: true }).click()
  await first.locator('.desktop-controls').getByRole('button', { name: 'Read window text', exact: true }).click()
  await expect(first.getByText('Review complete', { exact: true })).toBeVisible()
  expect((await state()).starts).toBe(0)
  expect((await state()).observations).toBe(1)
  await first.getByRole('button', { name: 'Close window text' }).click()
  await first.getByTestId('computer-control-start').click()
  await expect(page.getByTestId('computer-control-status')).toContainText('Ready for your next task')
  await first.locator('.mini-chat-write input').fill('Read this window when I send the task')
  expect((await state()).control.state).toBe('ready')
  expect((await state()).starts).toBe(1)
  await expect(second.getByRole('button', { name: 'Choose an app window', exact: true })).toBeDisabled()
  await expect(second.getByText('Another chat has computer control. Stop that session before starting here.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('computer-control-stop')).toContainText('Dismiss')
  await expect(first.getByRole('button', { name: 'Allow control again' })).toBeVisible()
  await expect(first.getByRole('button', { name: 'Disconnect app window' })).toBeEnabled()
  await expect(second.getByRole('button', { name: 'Choose an app window', exact: true })).toBeEnabled()
  expect((await state()).bindings[0]?.readable).toBe(false)
  await first.getByRole('button', { name: 'Change window: Quarterly workbook', exact: true }).click()
  await expect(first.getByRole('textbox', { name: 'Find an app window' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(first.getByRole('textbox', { name: 'Find an app window' })).toHaveCount(0)
  expect((await state()).control.state).toBe('paused')
  await page.getByTestId('computer-control-stop').click()
  await expect(page.getByTestId('computer-control-status')).toHaveCount(0)
  expect((await state()).captures).toBe(0)
})

test('pending consent is not duplicated and the stop control remains available across views', async () => {
  await page.evaluate((lane) => window.engram.desktopChoose(lane, 'window:101:0'), lanes[0]!)
  await orbit()
  await control({ state: 'needs-person', lane: lanes[0]!, name: 'Quarterly workbook', reason: 'Check the permission request.' })
  await expect(page.getByTestId('computer-control-status')).toContainText('Your attention is needed')
  await expect(page.getByRole('button', { name: 'Allow control again' })).toHaveCount(0)
  await control({ state: 'running', lane: lanes[0]!, name: 'Quarterly workbook' })
  await mkdir(join(TMP, 'desktop-control-ui'), { recursive: true })
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 })
    if (width <= 900 && await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-close').click()
    await expect(page.getByTestId('computer-control-stop')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: join(TMP, 'desktop-control-ui', `electron-orbit-${width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  if (!await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId('activity-settings').click()
  await expect(page.getByTestId('computer-settings')).toContainText('On for one chat')
  await expect(page.getByTestId('computer-control-stop')).toBeVisible()
  expect(await page.locator('.settings-box').evaluate((box) => box.getBoundingClientRect().bottom <= document.querySelector('.computer-status')!.getBoundingClientRect().top)).toBe(true)
  await page.getByTestId('computer-control-stop').click()
  await expect(page.getByTestId('computer-settings')).toContainText('Paused')
  await page.getByTestId('computer-control-stop').click()
  await expect(page.getByTestId('computer-control-status')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await orbit()
  await page.getByTestId('mission-tile-0').locator('.mission-enter').click()
  if (!await page.getByTestId('desktop-chat-pane').isVisible()) await page.getByTestId('composer-computer').click()
  await expect(page.getByTestId('desktop-chat-pane')).toBeVisible()
  await page.getByTestId('desktop-chat-pane').getByRole('button', { name: 'Browser', exact: true }).click()
  await expect(page.getByTestId('web-pane')).toBeVisible()
  await page.getByTestId('web-pane').getByRole('button', { name: 'Computer', exact: true }).click()
  await expect(page.getByTestId('desktop-chat-pane')).toBeVisible()
  expect((await state()).starts).toBe(0)
  expect((await state()).captures).toBe(0)
})
