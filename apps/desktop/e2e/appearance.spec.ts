import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let env: Record<string, string>
const start = async () => {
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
}
test.beforeEach(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'appearance-vault-'))
  await initVault(vault, { git: false })
  env = { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'appearance-userdata-')), ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' }
  await start()
})
test.afterEach(async () => { await app?.close() })

test('appearance survives restart, follows the system only when chosen, and keeps sections usable', async () => {
  await page.getByTestId('activity-settings').click()
  await page.getByRole('radio', { name: 'Dark', exact: true }).check()
  await page.getByTestId('setting-autostart').check()
  for (const section of ['ai', 'computer', 'memory', 'about', 'general']) {
    await page.getByTestId(`settings-nav-${section}`).click()
    await expect(page.getByTestId(`settings-nav-${section}`)).toHaveAttribute('aria-current', 'page')
  }
  await expect(page.getByTestId('setting-autostart')).toBeChecked()
  await page.getByTestId('setting-autostart').uncheck()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
  await app.close()
  await start()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByTestId('activity-settings').click()
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
  await page.getByRole('radio', { name: 'Light', exact: true }).check()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
  await page.getByTestId('activity-settings').click()
  await page.getByRole('radio', { name: 'Use system setting' }).check()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.setViewportSize({ width: 620, height: 720 })
  await page.getByTestId('activity-settings').click()
  await page.getByTestId('settings-nav-about').click()
  await expect(page.getByTestId('settings-feedback')).toBeVisible()
  expect(await page.getByTestId('settings-view').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
})

test('native window activation fades only the sidebar tint, without recoloring controls', async () => {
  const sidebar = page.getByTestId('app-sidebar')
  const tintOpacity = () => sidebar.evaluate((node) => getComputedStyle(node, '::before').opacity)
  for (const active of [true, false, true]) {
    await app.evaluate(({ BrowserWindow }, value) => { BrowserWindow.getAllWindows()[0]!.emit(value ? 'focus' : 'blur') }, active)
    await expect(page.locator('html')).toHaveAttribute('data-window-focused', String(active))
    await expect.poll(tintOpacity).toBe(active ? '1' : '0')
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
    expect(['#242424', '#eeeeee']).toContain(accent)
  }
})
