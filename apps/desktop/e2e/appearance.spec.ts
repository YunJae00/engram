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
  await page.evaluate(() => { for (const animation of document.getAnimations()) if (animation.effect?.getTiming().iterations !== Infinity) animation.finish() })
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
  page = await app.firstWindow({ timeout: 60_000 })
  await expect(page.getByTestId('shell')).toBeVisible()
}
test.beforeEach(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'appearance-vault-'))
  await initVault(vault, { git: false })
  env = { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'appearance-userdata-')), ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_DEVELOPER_FIXTURE: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' }
  await start()
})
test.afterEach(async () => { await app?.close() })

test('update checks show progress, recover from failure and allow retry', async () => {
  await app.evaluate(({ ipcMain }) => {
    let attempts = 0
    ipcMain.removeHandler('update:check')
    ipcMain.handle('update:check', async () => {
      if (++attempts === 1) await new Promise((_resolve, reject) => {
        ;(globalThis as typeof globalThis & { failUpdate: () => void }).failUpdate = () => reject(new Error('Isolated update fixture failure'))
      })
      return { state: 'current', selfInstalls: false }
    })
  })
  await openActivity(page, 'settings')
  const check = page.getByTestId('settings-update-check')
  await expect(check).toBeDisabled()
  await expect(check.locator('.spin')).toBeVisible()
  await expect(page.getByTestId('settings-update')).toHaveAttribute('aria-busy', 'true')
  await app.evaluate(() => (globalThis as typeof globalThis & { failUpdate: () => void }).failUpdate())
  await expect(page.getByTestId('settings-update')).toContainText('Could not check for updates. Try again.')
  await expect(check).toBeEnabled()
  await check.click()
  await expect(check).toBeEnabled()
  await expect(page.getByTestId('settings-update')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByTestId('settings-update')).not.toContainText('Could not check')
})

test('appearance saves immediately, survives restart and follows the system only when chosen', async () => {
  await openActivity(page, 'settings')
  await page.getByRole('radio', { name: 'Dark', exact: true }).check()
  await expect.poll(() => page.evaluate(() => window.engram.settingsGet().then(settings => settings.theme))).toBe('dark')
  await expect(page.getByTestId('setting-autostart')).toHaveCount(0)
  expect(await page.evaluate(() => window.engram.settingsGet().then(settings => settings.autoStart))).toBe(true)
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
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
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light')
  await openActivity(page, 'settings')
  await page.getByRole('radio', { name: 'System', exact: true }).check()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.setViewportSize({ width: 620, height: 720 })
  await openActivity(page, 'settings')
  await expect(page.getByTestId('settings-feedback')).toHaveCount(0)
  await expect(page.getByTestId('settings-theme')).toBeVisible()
  expect(await page.getByTestId('settings-view').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
})

test('a theme save that fails shows a toast, preserves the saved choice and allows retry', async () => {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const save = handlers.get('settings:set')!
    let attempts = 0
    ipcMain.removeHandler('settings:set')
    ipcMain.handle('settings:set', async (...args) => {
      if (++attempts === 1) await new Promise((_resolve, reject) => {
        ;(globalThis as typeof globalThis & { failSettings: () => void }).failSettings = () => reject(new Error('Isolated save fixture failure'))
      })
      return save(...args)
    })
  })
  const before = await page.evaluate(() => window.engram.settingsGet().then(settings => settings.theme))
  await openActivity(page, 'settings')
  const settings = page.getByTestId('settings-view')
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
  await expect(settings.locator('.dialog-actions')).toHaveCount(0)
  await expect(settings.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0)
  await expect.poll(() => app.evaluate(() => typeof (globalThis as typeof globalThis & { failSettings?: () => void }).failSettings)).toBe('function')
  await app.evaluate(() => (globalThis as typeof globalThis & { failSettings: () => void }).failSettings())
  await expect(page.locator('.toast', { hasText: 'Isolated save fixture failure' })).toBeVisible()
  expect(await page.evaluate(() => window.engram.settingsGet().then(value => value.theme))).toBe(before)
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).not.toBeChecked()
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked()
  await expect.poll(() => page.evaluate(() => window.engram.settingsGet().then(value => value.theme))).toBe('dark')
})

test('native window activation fades only the sidebar tint, without recoloring controls', async () => {
  const sidebar = page.getByTestId('app-sidebar')
  const tintOpacity = () => sidebar.evaluate((node) => getComputedStyle(node, '::before').opacity)
  const accents: string[] = []
  for (const active of [true, false, true]) {
    await app.evaluate(({ BrowserWindow }, value) => { BrowserWindow.getAllWindows()[0]!.emit(value ? 'focus' : 'blur') }, active)
    await expect(page.locator('html')).toHaveAttribute('data-window-focused', String(active))
    await expect.poll(tintOpacity).toBe(active ? '1' : '0')
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
    expect(['#1C1C1E', '#eeeeee']).toContain(accent)
    accents.push(accent)
  }
  expect(new Set(accents).size).toBe(1)
})

test('compact navigation and settings retain clear actions, safety guidance and narrow layouts', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const comets = page.getByRole('button', { name: 'Bots mode', exact: true })
  await expect(comets.locator('svg path[stroke-linejoin="round"]')).toHaveCount(1)
  await page.getByTestId('engram-menu-button').click()
  const menu = page.getByTestId('engram-menu')
  await expect(menu.getByTestId('activity-bots')).toBeVisible()
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
  for (const id of ['setting-desk-journal', 'audit-open', 'settings-github-backup']) await expect(settings.getByTestId(id)).toHaveCount(0)
  await expect(settings.getByText('Learning from your AI CLI sessions')).toHaveCount(0)
  await screenshot('compact-settings-memory.png')
  await expect(settings.getByTestId('settings-developers').getByRole('heading', { name: 'Advanced', exact: true })).toBeVisible()
  await settings.locator('summary').filter({ hasText: /^Provider integrations$/ }).click()
  await expect(settings.getByRole('checkbox', { name: 'Provider hooks & project settings' })).toBeVisible()
  await expect(settings.getByText(/can run commands without Engram approval/)).toBeVisible()
  await expect(settings.getByText(/Returned content is shared/)).toBeVisible()
  await expect(settings.getByRole('heading', { name: 'Saved edit decisions' })).toHaveCount(0)
  await screenshot('compact-settings-advanced.png')
  await page.evaluate(async () => window.engram.settingsSet({ ...await window.engram.settingsGet(), theme: 'dark' }))
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.setViewportSize({ width: 600, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
  await settings.getByTestId('settings-reset').scrollIntoViewIfNeeded()
  await expect(settings.getByTestId('settings-reset')).toBeInViewport()
  await screenshot('compact-settings-narrow-dark.png')
  expect(await settings.evaluate(node => getComputedStyle(node).animationName)).toBe('none')
})

test('compact settings are one page of five groups with advanced tools in their own block at 600 pixels', async () => {
  await page.setViewportSize({ width: 600, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openActivity(page, 'settings')
  const settings = page.getByTestId('settings-view')
  for (const theme of ['light', 'dark'] as const) {
    await page.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).check()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    expect(await settings.locator('.settings-panel > *').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid') ?? node.className))).toEqual(['settings-theme', 'settings-shortcut', 'engine-settings', 'settings-start-fresh', 'settings-about', 'settings-developers'])
    await expect(settings.locator('[data-testid^="settings-nav-"]')).toHaveCount(0)
    await expect(settings.getByTestId('ai-check-filing')).toBeVisible()
    await screenshot(`minimal-settings-general-${theme}-600.png`)
    for (const id of ['setting-autostart', 'setting-desk-journal', 'setting-work-map', 'setting-work-files', 'setting-work-apps', 'audit-open', 'computer-settings', 'help-panel', 'settings-export-logs', 'settings-github-backup']) await expect(settings.getByTestId(id)).toHaveCount(0)
    await expect(settings.getByTestId('task-recording-settings')).toHaveCount(0)
    await expect(settings.getByText(/Pages and files are never opened/)).toHaveCount(0)
    await screenshot(`minimal-settings-memory-${theme}-600.png`)
    await expect(settings.getByTestId('settings-developers').getByRole('heading', { name: 'Advanced', exact: true })).toBeVisible()
    const integrations = settings.getByRole('checkbox', { name: 'Provider hooks & project settings', includeHidden: true })
    const share = settings.getByRole('switch', { name: /Share Engram tools/ })
    await expect(integrations).toBeHidden()
    await expect(share).not.toBeChecked()
    await expect(settings.getByText(/Each request needs your approval/)).toBeVisible()
    await expect(settings.getByTestId('external-client-claude')).toBeHidden()
    await screenshot(`minimal-settings-advanced-${theme}-600.png`)
    await settings.locator('summary').filter({ hasText: /^Provider integrations$/ }).click()
    await expect(integrations).not.toBeChecked()
    await expect(settings.getByText(/can run commands without Engram approval/)).toBeVisible()
    expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
    await settings.getByText(/can run commands without Engram approval/).scrollIntoViewIfNeeded()
    await screenshot(`minimal-settings-provider-warning-${theme}-600.png`)
    await share.check()
    await expect(settings.getByTestId('external-client-claude')).toBeVisible()
    await share.scrollIntoViewIfNeeded()
    await screenshot(`minimal-settings-sharing-${theme}-600.png`)
    await share.uncheck()
    await settings.locator('summary').filter({ hasText: /^Provider integrations$/ }).click()
    const about = settings.getByTestId('settings-about')
    await expect(about).toContainText('Version')
    await expect(about.getByTestId('settings-version')).toBeVisible()
    await expect(about.getByTestId('settings-update-check')).toBeVisible()
    await expect(settings.getByTestId('settings-reset')).toBeVisible()
    await expect(about).not.toContainText('Routines')
    await expect(about).not.toContainText('Make it yours')
    await expect(settings.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expect(settings.locator('.dialog-actions')).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0)
    await screenshot(`minimal-settings-help-${theme}-600.png`)
  }
  await settings.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(settings).toHaveCount(0)
})

test('apps used lately carry their own icon and clean name, apps that only sent notifications are listed, and the lock screen is not one', async () => {
  await app.close()
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const spans = [
    { app: 'msedge', title: 'Sheet - Work - Microsoft? Edge', start: at(50), end: at(40) },
    { app: 'LockApp', title: 'Windows Lock Screen', start: at(40), end: at(30) },
    { app: 'node', title: 'notes.txt - Node', start: at(30), end: at(10) },
  ]
  const ledger = join(env.ENGRAM_VAULT!, 'workspace', '.engram', 'activity')
  await mkdir(ledger, { recursive: true })
  for (const span of spans) await writeFile(join(ledger, `${span.start.slice(0, 10)}.jsonl`), `${JSON.stringify(span)}\n`, { flag: 'a' })
  await writeFile(join(env.ENGRAM_USERDATA!, 'app-paths.json'), JSON.stringify({ node: process.execPath }))
  const toasts = [
    { id: 'a1', app: 'Node', aumid: 'node', at: at(20), title: 'Build done', text: '' },
    { id: 'b2', app: 'Microsoft Teams', aumid: 'MSTeams_8wekyb3d8bbwe!MSTeams', at: at(15), title: 'Mina', text: 'Lunch?' },
  ]
  const kept = join(env.ENGRAM_VAULT!, 'workspace', '.engram', 'notifications')
  await mkdir(kept, { recursive: true })
  for (const toast of toasts) await writeFile(join(kept, `${toast.at.slice(0, 10)}.jsonl`), `${JSON.stringify(toast)}\n`, { flag: 'a' })
  await start()
  await app.evaluate(({ app, nativeImage }, program) => {
    const getFileIcon = app.getFileIcon.bind(app)
    app.getFileIcon = (path, options) => path === program
      ? Promise.resolve(nativeImage.createFromBitmap(Buffer.from([220, 80, 30, 255]), { width: 1, height: 1 }))
      : getFileIcon(path, options)
  }, process.execPath)
  await openActivity(page, 'settings')
  await expect(page.getByTestId('apps-settings')).toHaveCount(0)
  const rows = await page.evaluate(() => window.engram.appsList())
  const row = (app: string) => rows.find(one => one.app === app)
  expect(row('node')).toMatchObject({ label: 'Node', notes: 1, on: true })
  expect(row('node')!.icon).toMatch(/^data:image\/png;base64,/)
  expect(row('msedge')).toMatchObject({ label: 'Microsoft Edge' })
  expect(row('msedge')!.icon).toBeUndefined()
  expect(row('microsoft teams')).toMatchObject({ label: 'Microsoft Teams', notes: 1, on: true })
  expect(row('lockapp')).toBeUndefined()
})
