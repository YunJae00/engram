import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EngineLoginDto } from '../src/shared/types.js'
test.describe.configure({ mode: 'serial' })

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
type Fixture = { delayed: boolean; signed: Record<string, boolean>; login: EngineLoginDto[]; opened: number; finish?: () => void }
type Global = typeof globalThis & { engineFixture: Fixture }
test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-engines-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-engines-userdata-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const state: Fixture = { delayed: true, signed: { claude: false, codex: false }, login: [], opened: 0 }
    ;(globalThis as Global).engineFixture = state
    const tell = (login: EngineLoginDto) => { state.login = [login]; for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:login', login }) }
    const handle = (name: string, fn: (...args: unknown[]) => unknown) => { ipcMain.removeHandler(name); ipcMain.handle(name, (_event, ...args) => fn(...args)) }
    handle('engines:states', () => state.delayed ? new Promise(() => undefined) : ['claude', 'codex'].map((id) => ({ id, installed: true, loggedIn: state.signed[id] })))
    handle('engines:logins', () => state.login)
    handle('models:list', (id) => [{ value: `${id}-fast`, label: 'Quick', detail: 'For everyday work' }, { value: `${id}-deep`, label: 'Thorough', detail: 'For harder tasks' }])
    handle('engines:connect', (value) => {
      const id = value as 'claude' | 'codex'
      tell({ id, phase: 'browser', canOpen: true })
      return new Promise((resolve) => { state.finish = () => { state.signed[id] = true; tell({ id, phase: 'connected', canOpen: false }); resolve({ ok: true }) } })
    })
    handle('engines:openLogin', () => { state.opened++ })
    handle('engines:cancelLogin', (id) => { tell({ id: id as 'claude' | 'codex', phase: 'idle', canOpen: false }); state.finish = undefined })
  })
  await page.setViewportSize({ width: 1280, height: 880 })
})
test.afterAll(async () => { await app?.close() })

test('settings stays usable while a runtime probe never answers', async () => {
  await page.getByTestId('activity-settings').click()
  await expect(page.getByTestId('settings-nav-ai')).toBeEnabled({ timeout: 2000 })
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByTestId('brain-claude-status')).toContainText('Checking connection')
  await page.getByTestId('settings-nav-general').click()
  await expect(page.getByTestId('settings-nav-general')).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Escape')
})

test('both sign-in cards survive reopening settings and offer cancel and browser recovery', async () => {
  await app.evaluate(() => { (globalThis as Global).engineFixture.delayed = false })
  for (const id of ['claude', 'codex']) {
    await page.getByTestId('activity-settings').click()
    await page.getByTestId('settings-nav-ai').click()
    await page.getByTestId(`brain-${id}-connect`).click()
    await expect(page.getByTestId(`brain-${id}-status`)).toContainText('Finish signing in')
    await page.keyboard.press('Escape')
    await page.getByTestId('activity-settings').click()
    await page.getByTestId('settings-nav-ai').click()
    await expect(page.getByTestId(`brain-${id}-status`)).toContainText('Finish signing in')
    await page.getByRole('button', { name: 'Open browser' }).click()
    await page.getByTestId(`brain-${id}-cancel`).click()
    await expect(page.getByTestId(`brain-${id}-connect`)).toBeEnabled()
    await page.getByTestId(`brain-${id}-connect`).click()
    await app.evaluate(() => (globalThis as Global).engineFixture.finish?.())
    await expect(page.getByTestId(`brain-${id}-status`)).toContainText('Connected')
    await page.getByTestId(`model-${id}`).selectOption(`${id}-deep`)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => page.evaluate(async (engine) => { const settings = await window.engram.settingsGet(); return engine === 'claude' ? settings.claudeModel : settings.codexModel }, id)).toBe(`${id}-deep`)
  }
  expect(await app.evaluate(() => (globalThis as Global).engineFixture.opened)).toBe(2)
})

test('ChatGPT models can be selected in the composer without changing the Claude choice', async () => {
  const picker = page.getByTestId('model-picker')
  await expect(picker).toBeEnabled()
  await picker.click()
  await page.getByTestId('model-pick-codex-fast').click()
  await expect(picker).toContainText('Quick')
  expect(await page.evaluate(async () => { const settings = await window.engram.settingsGet(); return [settings.claudeModel, settings.codexModel] })).toEqual(['claude-deep', 'codex-fast'])
  await page.getByTestId('activity-settings').click()
  await page.getByTestId('settings-nav-ai').click()
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!
    await window.webContents.capturePage()
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(TMP, 'engine-settings-light.png'), Buffer.from(png, 'base64'))
  await page.keyboard.press('Escape')
})
