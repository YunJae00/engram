import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { openActivity } from './navigation.js'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let env: Record<string, string>
async function screenshot(file: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(TMP, file), Buffer.from(png, 'base64'))
}
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

test('update checks show progress, recover from failure and allow retry', async () => {
  await app.evaluate(({ ipcMain }) => {
    let attempts = 0
    ipcMain.removeHandler('update:check')
    ipcMain.handle('update:check', async () => {
      await new Promise(resolve => setTimeout(resolve, 800))
      if (++attempts === 1) throw new Error('Isolated update fixture failure')
      return { state: 'current', selfInstalls: false }
    })
  })
  await openActivity(page, 'settings')
  const check = page.getByTestId('settings-update-check')
  await check.click()
  await expect(check).toBeDisabled()
  await expect(check.locator('.spin')).toBeVisible()
  await expect(page.getByTestId('settings-update')).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByTestId('settings-update')).toContainText('Could not check for updates. Try again.')
  await expect(check).toBeEnabled()
  await check.click()
  await expect(check).toBeEnabled()
  await expect(page.getByTestId('settings-update')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByTestId('settings-update')).not.toContainText('Could not check')
})

test('appearance survives restart, follows the system only when chosen, and keeps sections usable', async () => {
  await openActivity(page, 'settings')
  await page.getByRole('radio', { name: 'Dark', exact: true }).check()
  await page.getByTestId('setting-autostart').check()
  for (const section of ['ai', 'developers', 'memory', 'help', 'general']) {
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
  await openActivity(page, 'settings')
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
  await page.getByRole('radio', { name: 'Light', exact: true }).check()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
  await openActivity(page, 'settings')
  await page.getByRole('radio', { name: 'Use system setting' }).check()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.setViewportSize({ width: 620, height: 720 })
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-general').click()
  await expect(page.getByTestId('settings-feedback')).toBeVisible()
  expect(await page.getByTestId('settings-view').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
})

test('settings save shows progress and retains the dialog on failure', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('settings:set')
    ipcMain.handle('settings:set', async () => {
      await new Promise(resolve => setTimeout(resolve, 800))
      throw new Error('Isolated save fixture failure')
    })
  })
  await openActivity(page, 'settings')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  const pending = page.getByRole('button', { name: 'Saving…', exact: true })
  await expect(pending).toBeDisabled()
  await expect(pending.locator('.spin')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await expect(page.getByText(/Isolated save fixture failure/)).toBeVisible()
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

test('compact navigation and settings retain clear actions, safety guidance and narrow layouts', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const comets = page.getByRole('button', { name: 'Comets mode', exact: true })
  await expect(comets.locator('svg path[fill-rule="evenodd"]')).toHaveCount(1)
  await page.getByTestId('workspace-switcher').click()
  const menu = page.getByTestId('workspace-menu')
  await expect(menu.getByTestId('activity-bots')).toHaveCount(0)
  await expect(menu.getByTestId('activity-developers')).toHaveCount(0)
  await expect(menu.getByTestId('workspace-github-backup')).toHaveCount(0)
  await screenshot('compact-menu.png')
  await page.keyboard.press('Escape')
  await page.getByTestId('app-sidebar-close').click()
  await expect(comets).toBeVisible()
  await comets.click()
  await expect(comets).toHaveAttribute('aria-pressed', 'true')
  await openActivity(page, 'settings')
  const settings = page.getByTestId('settings-view')
  await screenshot('compact-settings-general.png')
  await page.getByTestId('settings-nav-memory').click()
  await expect(settings.getByText('Records foreground app names and window titles.')).toBeVisible()
  await expect(settings.getByTestId('audit-open')).toHaveText('Open folder')
  await expect(settings.getByTestId('settings-github-backup')).toHaveText('Set up')
  await expect(settings.getByText('Learning from your AI CLI sessions')).toHaveCount(0)
  await screenshot('compact-settings-memory.png')
  await page.getByTestId('settings-nav-developers').click()
  await expect(settings.getByRole('checkbox', { name: 'Provider hooks & project settings' })).toBeVisible()
  await expect(settings.getByText(/can run commands without Engram approval/)).toBeVisible()
  await expect(settings.getByText(/Returned content is shared/)).toBeVisible()
  await expect(settings.getByRole('heading', { name: 'Saved edit decisions' })).toHaveCount(0)
  await screenshot('compact-settings-workspace.png')
  await page.evaluate(async () => window.engram.settingsSet({ ...await window.engram.settingsGet(), theme: 'dark' }))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.setViewportSize({ width: 600, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const section of ['developers', 'memory', 'ai', 'general']) {
    await page.getByTestId(`settings-nav-${section}`).click()
    expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  }
  await page.getByTestId('settings-nav-memory').click()
  await expect(settings.getByTestId('settings-github-backup')).toBeInViewport()
  await screenshot('compact-settings-narrow-dark.png')
  expect(await settings.evaluate(node => getComputedStyle(node).animationName)).toBe('none')
})
