import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeTestApp } from './navigation.js'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
// First run ends on the primary bot: AI → preferences → first bot → its empty screen.
const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
let app: ElectronApplication
let page: Page
let vaultRoot: string
let mockDir: string

async function launch() {
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-first-bot-home-'))
  mockDir = join(userData, 'mock')
  await mkdir(mockDir); await writeFile(join(mockDir, 'default.txt'), 'OK')
  const env = { ...process.env, ENGRAM_VAULT: '', ENGRAM_USERDATA: userData, ENGRAM_ONBOARD_ROOT: vaultRoot, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_BROWSER_EXTERNAL: '0' }
  app = await electron.launch({ timeout: 90000, args: [MAIN_ENTRY, '--no-sandbox'], env })
  page = await app.firstWindow({ timeout: 90000 })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('models:list'); ipcMain.handle('models:list', (_event, id: string) => [{ value: `${id}-quick`, label: 'Quick model', detail: 'Fixture' }])
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
}

async function toStep3() {
  await expect(page.getByTestId('onboarding')).toBeVisible()
  await page.getByTestId('onboard-next').click()
  await app.evaluate(({ ipcMain, BrowserWindow }, dir) => {
    process.env['ENGRAM_ENGINE'] = 'mock'; process.env['ENGRAM_MOCK_DIR'] = dir
    ipcMain.removeHandler('engines:states'); ipcMain.handle('engines:states', () => [{ id: 'codex', installed: true, loggedIn: true }])
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:detected' })
  }, mockDir)
  await page.getByTestId('onboard-choose-codex').check()
  await page.getByTestId('onboard-model').click(); await page.getByRole('menuitemradio', { name: 'Quick model', exact: true }).click()
  await page.getByTestId('onboard-ai-next').click()
  await expect(page.getByTestId('onboard-step-3')).toBeVisible()
}

async function toStep4() {
  await toStep3()
  await page.getByTestId('onboard-prefs-next').click()
  await expect(page.getByTestId('onboard-step-4')).toBeVisible()
}

const bots = () => page.evaluate(() => window.engram.botsList())
const landed = () => page.locator('[data-testid="bots-thread"] [data-testid="bot-empty"]')

test.beforeEach(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  vaultRoot = join(await mkdtemp(join(REPO_TMP, 'e2e-first-bot-')), 'Engram')
  await launch()
})

test.afterEach(async () => { await closeTestApp(app) })

test('finishing with the bot step renames the primary bot and keeps one bot', async () => {
  await toStep4()
  await expect(page.locator('[data-testid="onboard-step-4"] .bot-avatar')).toBeVisible()
  await expect(page.getByTestId('onboard-bot-name')).toHaveValue('Engram')
  await page.getByTestId('onboard-bot-name').fill('Sol')
  await page.getByTestId('onboard-bot-label').fill('Research')
  await page.getByTestId('onboard-finish').click()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60000 })
  await expect(landed()).toContainText('Sol')
  const list = await bots()
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ primary: true, name: 'Sol', label: 'Research' })
  expect(await page.evaluate(() => localStorage.getItem('engram.onboardBot'))).toBeNull()
})

test('re-running onboarding on the same vault keeps exactly one primary bot', async () => {
  await toStep4()
  await page.getByTestId('onboard-finish').click()
  await expect(landed()).toBeVisible({ timeout: 60000 })
  await closeTestApp(app)
  await launch()
  await toStep4()
  await page.getByTestId('onboard-bot-name').fill('Again')
  await page.getByTestId('onboard-finish').click()
  await expect(landed()).toContainText('Again', { timeout: 60000 })
  const list = await bots()
  expect(list).toHaveLength(1)
  expect(list.filter(bot => bot.primary === true)).toHaveLength(1)
})

test('each step after the AI step can be skipped', async () => {
  const activity = await page.evaluate(() => window.engram.activityGet())
  await toStep3()
  await page.getByTestId('onboard-source-workFiles').check()
  await page.getByTestId('onboard-prefs-skip').click()
  await expect(page.getByTestId('onboard-step-4')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  for (const key of ['workMap', 'workFiles', 'workApps']) await expect(page.getByTestId(`onboard-source-${key}`)).not.toBeChecked()
  await expect(page.getByTestId('onboard-source-activity')).toBeChecked({ checked: activity })
  await page.getByTestId('onboard-prefs-next').click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))!.setContentSize(480, 520))
  await expect(page.getByTestId('onboard-bot-skip')).toBeInViewport()
  await expect(page.getByTestId('onboard-finish')).toBeInViewport()
  expect(await page.locator('.onboard-card').evaluate(card => card.scrollWidth <= card.clientWidth)).toBe(true)
  await page.getByTestId('onboard-bot-name').fill('Ignored')
  await page.getByTestId('onboard-bot-skip').click()
  await expect(landed()).toContainText('Engram', { timeout: 60000 })
  const list = await bots()
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ primary: true, name: 'Engram' })
  expect(await page.evaluate(() => window.engram.settingsGet().then(settings => [settings.workMap, settings.workFiles, settings.workApps]))).toEqual([false, false, false])
})

test('onboarding never asks for a login or an account', async () => {
  const asks = () => page.getByTestId('onboarding').evaluate(root => [...root.querySelectorAll('*')].filter(el => !el.closest('.onboard-providers')).flatMap(el => {
    const own = [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join(' ')
    return [own, el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '', el.getAttribute('placeholder') ?? ''].filter(text => /log ?in|sign ?up|account/i.test(text))
  }))
  await expect(page.getByTestId('onboard-step-1')).toBeVisible()
  expect(await asks()).toEqual([])
  await toStep3()
  expect(await asks()).toEqual([])
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  expect(await asks()).toEqual([])
  await page.getByTestId('onboard-ai-next').click()
  await page.getByTestId('onboard-prefs-next').click()
  await expect(page.getByTestId('onboard-step-4')).toBeVisible()
  expect(await asks()).toEqual([])
})
