import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { openActivity } from './navigation.js'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

// Fresh setup reaches the shell only after a verified AI response.

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const PREVIEW = join(REPO_TMP, 'onboarding-preview')

let app: ElectronApplication
let page: Page
let vaultRoot: string
let mockDir: string
async function chooseModel(label: string) {
  await page.getByTestId('onboard-model').click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
}
async function screenshot(name: string) {
  const data = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.getURL().includes('index.html'))!
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise(resolve => setTimeout(resolve, 400))
    await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
    await new Promise(resolve => setTimeout(resolve, 450))
    return (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
  })
  await writeFile(join(PREVIEW, name), Buffer.from(data, 'base64'))
}

test.beforeEach(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  await mkdir(PREVIEW, { recursive: true })
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-home-'))
  mockDir = join(userData, 'mock')
  await mkdir(mockDir); await writeFile(join(mockDir, 'default.txt'), 'OK')
  vaultRoot = join(await mkdtemp(join(REPO_TMP, 'e2e-onboard-')), 'Engram')

  app = await electron.launch({
    timeout: 90000,
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      // NO ENGRAM_VAULT → onboarding must appear
      ENGRAM_VAULT: '',
      ENGRAM_USERDATA: userData,
      ENGRAM_ONBOARD_ROOT: vaultRoot,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
      ENGRAM_BROWSER_EXTERNAL: '0',
    },
  })
  page = await app.firstWindow({ timeout: 90000 })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('models:list')
    ipcMain.handle('models:list', (_event, id: string) => [{ value: `${id}-quick`, label: 'Quick model', detail: 'Fixture' }])
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

test.afterEach(async () => {
  await app?.close()
})

test('a fresh workspace requires verified AI before browsing', async () => {
  await expect(page.getByTestId('onboarding')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await expect(page.getByRole('heading', { name: 'Choose your workspace', exact: true })).toBeVisible()
  await page.getByTestId('vault-root-input').fill(' ')
  await expect(page.getByTestId('onboard-next')).toBeDisabled()
  await app.evaluate(({ ipcMain }, root) => {
    ipcMain.removeHandler('import:pick')
    ipcMain.handle('import:pick', () => root)
  }, vaultRoot)
  await page.getByRole('button', { name: 'Choose workspace folder', exact: true }).click()
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await page.getByTestId('onboard-next').click()
  await expect(page.getByTestId('onboard-skip-ai')).toHaveCount(0)
  await expect(page.getByTestId('onboard-ai-next')).toBeDisabled()
  await expect(page.getByTestId('onboard-sources')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Install Claude runtime' })).toBeVisible()
  await expect(page.getByText('Official runtime download. Anthropic’s terms apply.')).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await page.getByTestId('onboard-next').click()
  await app.evaluate(({ ipcMain, BrowserWindow }, dir) => {
    process.env['ENGRAM_ENGINE'] = 'mock'; process.env['ENGRAM_MOCK_DIR'] = dir
    ipcMain.removeHandler('engines:states')
    ipcMain.handle('engines:states', () => [{ id: 'codex', installed: true, loggedIn: true }])
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:detected' })
  }, mockDir)
  await expect(page.getByTestId('onboard-ai-next')).toBeDisabled()
  await page.getByTestId('onboard-choose-codex').check()
  await expect(page.getByTestId('onboard-ai-next')).toBeDisabled()
  await chooseModel('Quick model')
  await page.getByTestId('onboard-ai-next').click()
  for (const key of ['workMap', 'workFiles', 'workApps']) await expect(page.getByTestId(`onboard-source-${key}`)).not.toBeChecked()
  await expect(page.getByTestId('onboard-source-activity')).toBeChecked({ checked: await page.evaluate(() => window.engram.activityGet()) })
  await expect(page.getByTestId('onboard-sources')).toContainText('Pages and file contents are not read.')
  expect((await page.getByTestId('onboard-source-workMap').boundingBox())!.width).toBeLessThan(50)
  await page.getByTestId('onboard-source-workFiles').check()
  await page.getByTestId('onboard-interview').uncheck()
  await expect(page.getByTestId('onboard-computer-use')).not.toBeChecked()
  await expect(page.getByTestId('onboard-finish')).toBeEnabled()
  await page.getByTestId('onboard-finish').click()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60000 })
  expect(await page.evaluate(() => window.engram.settingsGet().then(settings => [settings.workMap, settings.workFiles, settings.workApps]))).toEqual([false, true, false])
  expect(await page.evaluate(() => window.engram.settingsGet().then(settings => [settings.defaultEngine, settings.codexModel, settings.aiSelections?.filing]))).toEqual(['codex', 'codex-quick', { engine: 'codex', model: 'codex-quick' }])
  await expect(page.getByTestId('welcome-web')).toBeEnabled()
  await app.evaluate(() => { process.env['ENGRAM_ENGINE'] = 'none' })
  const titled = await page.evaluate(async () => {
    const bot = await window.engram.botCreate({ name: 'New comet', purpose: '' })
    await window.engram.chatSend({ message: 'Review the project plan', history: [], engineId: 'claude', botId: bot.id, channel: `bot-${bot.id}` })
    return (await window.engram.botsList()).find(row => row.id === bot.id)?.name
  })
  expect(titled).toBe('Review the project plan')
})

test('compact setup keeps consent readable in narrow light and dark windows', async () => {
  test.setTimeout(120000)
  await expect(page.getByTestId('onboarding')).toBeVisible()
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const window = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))!
    window.setMinimumSize(0, 0); window.setContentSize(600, 800)
    ipcMain.removeHandler('engines:states')
    ipcMain.handle('engines:states', () => [
      { id: 'claude', installed: true, loggedIn: false },
      { id: 'codex', installed: true, loggedIn: true },
    ])
    window.webContents.send('engram:event', { type: 'engines:detected' })
  })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    await expect(page.getByRole('heading', { name: 'Choose your workspace', exact: true })).toBeVisible()
    await expect(page.locator('.onboard-sub')).toHaveCount(0)
    expect((await page.getByTestId('vault-root-input').boundingBox())!.width).toBeGreaterThan(200)
    await screenshot(`compact-workspace-${theme}.png`)
    await page.getByTestId('onboard-next').click()
    await expect(page.getByRole('heading', { name: 'Connect your AI', exact: true })).toBeVisible()
    await expect(page.getByTestId('onboard-connect-claude')).toBeEnabled()
    await expect(page.getByTestId('onboard-brain-codex')).toHaveText('Signed in')
    await expect(page.getByText('Signed in', { exact: true })).toHaveCount(1)
    await page.getByTestId('onboard-choose-codex').check()
    await chooseModel('Quick model')
    await expect(page.getByTestId('onboard-ai-next')).toBeInViewport()
    await expect(page.getByTestId('onboard-model')).toBeInViewport()
    await expect(page.getByTestId('onboard-sources')).toHaveCount(0)
    await screenshot(`compact-connect-${theme}.png`)
    await page.getByTestId('onboard-ai-next').click()
    await expect(page.getByTestId('onboard-source-workMap')).not.toBeChecked()
    await expect(page.getByTestId('onboard-interview')).toBeChecked()
    await expect(page.getByTestId('onboard-sources')).toContainText('Pages and file contents are not read.')
    await expect(page.locator('#interview-consent')).toContainText('selected notes')
    await expect(page.locator('#interview-consent')).toContainText('No new document scan')
    for (const selector of ['[data-testid="onboard-sources"]', '#interview-consent']) {
      await page.locator(selector).scrollIntoViewIfNeeded()
      await expect(page.locator(selector)).toBeInViewport()
      await expect(page.getByTestId('onboard-finish')).toBeInViewport()
    }
    expect(await page.locator('.onboard-card').evaluate(card => ({ overflowX: card.scrollWidth > card.clientWidth, overflowY: card.scrollHeight > card.clientHeight }))).toEqual({ overflowX: false, overflowY: false })
    await screenshot(`compact-preferences-${theme}.png`)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))!.setContentSize(600, 600))
    await expect(page.locator('.learning-details')).toHaveCount(0)
    await page.getByTestId('onboard-computer-use').scrollIntoViewIfNeeded()
    await expect(page.getByTestId('onboard-finish')).toBeInViewport()
    await expect(page.getByRole('heading', { name: 'Make it yours', exact: true })).toBeInViewport()
    expect(await page.locator('.onboard-card').evaluate(card => card.scrollWidth <= card.clientWidth && card.scrollHeight <= card.clientHeight)).toBe(true)
    expect(await page.locator('.onboard-ai-content').evaluate(content => {
      const body = content.getBoundingClientRect(), card = content.closest('.onboard-card')!.getBoundingClientRect()
      return body.right < card.right - 20 && body.left > card.left + 20 && content.scrollHeight >= content.clientHeight
    })).toBe(true)
    await screenshot(`compact-scroll-${theme}.png`)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('index.html'))!.setContentSize(600, 800))
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
  }
})

test('signed-in metadata cannot finish setup when the AI request fails', async () => {
  await expect(page.getByTestId('onboarding')).toBeVisible()
  await writeFile(join(mockDir, 'default.txt'), '')
  await app.evaluate(({ ipcMain, BrowserWindow }, dir) => {
    process.env['ENGRAM_ENGINE'] = 'mock'; process.env['ENGRAM_MOCK_DIR'] = dir
    ipcMain.removeHandler('engines:states')
    ipcMain.handle('engines:states', () => [{ id: 'codex', installed: true, loggedIn: true }])
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:detected' })
  }, mockDir)
  await page.getByTestId('onboard-next').click()
  await expect(page.getByTestId('onboard-brain-codex')).toHaveText('Signed in')
  await page.getByTestId('onboard-choose-codex').check()
  await chooseModel('Provider default')
  await page.getByTestId('onboard-ai-next').click()
  await page.getByTestId('onboard-interview').uncheck()
  await page.getByTestId('onboard-finish').click()
  await expect(page.getByRole('alert')).toContainText('did not answer the connection check')
  await expect(page.getByTestId('onboard-brain-codex')).toHaveText('Check failed')
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await expect(access(vaultRoot)).rejects.toThrow()
  await writeFile(join(mockDir, 'default.txt'), 'OK')
  await page.getByTestId('onboard-ai-next').click()
  await page.getByTestId('onboard-finish').click()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60000 })
})

test('models must finish loading before selection and setup can continue', async () => {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('engines:states')
    ipcMain.handle('engines:states', () => [{ id: 'claude', installed: true, loggedIn: true }])
    ipcMain.removeHandler('models:list')
    ipcMain.handle('models:list', () => new Promise(resolve => { (globalThis as typeof globalThis & { finishModels?: () => void }).finishModels = () => resolve([{ value: 'sonnet', label: 'Sonnet', detail: 'Fixture' }]) }))
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:detected' })
  })
  const choose = page.getByRole('button', { name: 'Choose workspace folder', exact: true })
  const next = page.getByTestId('onboard-next')
  expect(Math.abs((await choose.boundingBox())!.x - (await next.boundingBox())!.x)).toBeLessThan(2)
  await next.click()
  await page.getByTestId('onboard-choose-claude').check()
  await expect(page.getByTestId('onboard-model')).toBeDisabled()
  await expect(page.getByTestId('onboard-ai-next')).toBeDisabled()
  await expect(page.getByTestId('onboard-model')).toContainText('Loading models')
  await app.evaluate(() => (globalThis as typeof globalThis & { finishModels?: () => void }).finishModels!())
  await expect(page.getByTestId('onboard-model')).toBeEnabled()
  await expect(page.getByTestId('onboard-ai-next')).toBeDisabled()
  await page.getByTestId('onboard-model').focus()
  await page.getByTestId('onboard-model').press('ArrowDown')
  await expect(page.getByRole('menu', { name: 'Choose a model' })).toBeVisible()
  await page.getByRole('menuitemradio', { name: 'Provider default', exact: true }).press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'Sonnet', exact: true })).toBeFocused()
  await page.getByRole('menuitemradio', { name: 'Sonnet', exact: true }).press('Enter')
  await expect(page.getByTestId('onboard-model')).toHaveText('Sonnet')
  await expect(page.getByTestId('onboard-ai-next')).toBeEnabled()
})

test('first-run login states, filing retry and direct browser entry', async () => {
  test.setTimeout(240000)
  await expect(page.getByTestId('onboarding')).toBeVisible()

  // ① vault location (pre-filled from ENGRAM_ONBOARD_ROOT)
  await expect(page.getByTestId('onboard-step-1')).toBeVisible()
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await screenshot('01-workspace.png')
  // Replace only the authentication boundary in this isolated process.
  // No real account credentials, external browser login or model quota is used.
  await app.evaluate(({ ipcMain, BrowserWindow }, dir) => {
    process.env['ENGRAM_ENGINE'] = 'mock'; process.env['ENGRAM_MOCK_DIR'] = dir
    const states = [{ id: 'claude', installed: true, loggedIn: false }, { id: 'codex', installed: true, loggedIn: false }]
    let attempt = 0
    let cancel: (() => void) | undefined
    for (const channel of ['engines:states', 'engines:connect', 'engines:cancelLogin']) ipcMain.removeHandler(channel)
    ipcMain.handle('engines:states', () => states)
    ipcMain.handle('engines:cancelLogin', () => cancel?.())
    ipcMain.handle('engines:connect', async (_event, id: string) => {
      if (++attempt === 1) return { ok: false, message: 'Sign-in did not finish. Please try again.' }
      if (attempt === 2) {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:login', login: { id, phase: 'browser', canOpen: true } })
        return new Promise(resolve => { cancel = () => resolve({ ok: false, message: 'Sign-in cancelled.' }) })
      }
      states.find(state => state.id === id)!.loggedIn = true
      return { ok: true }
    })
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:detected' })
  }, mockDir)
  await page.getByTestId('onboard-next').click()

  // Sign-in must finish before the live connection check.
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await expect(page.getByTestId('onboard-connect-codex')).toBeEnabled()
  await screenshot('02-connect-ai.png')
  await page.getByTestId('onboard-connect-claude').click()
  await expect(page.getByRole('alert')).toContainText('Sign-in did not finish')
  await page.getByTestId('onboard-connect-claude').click()
  await expect(page.getByRole('button', { name: 'Open browser', exact: true })).toBeVisible()
  await expect(page.getByTestId('onboard-ai-next')).toBeDisabled()
  await screenshot('03-sign-in-waiting.png')
  await page.getByRole('button', { name: 'Cancel sign-in' }).click()
  await expect(page.getByTestId('onboard-connect-codex')).toBeEnabled()
  await page.getByTestId('onboard-connect-codex').click()
  await expect(page.getByTestId('onboard-brain-codex')).toHaveText('Signed in')
  expect(await page.evaluate(() => window.engram.settingsGet().then(settings => settings.defaultEngine))).toBe('claude')
  await page.getByTestId('onboard-connect-claude').click()
  await expect(page.getByTestId('onboard-brain-claude')).toHaveText('Signed in')
  // With two connected, the person says which answers first; nothing is guessed from the sign-in order.
  await expect(page.getByTestId('onboard-choice')).toBeVisible()
  await page.getByTestId('onboard-choose-codex').check()
  await chooseModel('Provider default')
  await screenshot('04-connected.png')
  await page.getByTestId('onboard-ai-next').click()
  await page.getByTestId('onboard-finish').click()

  // lands in the shell on the new vault
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  expect(await page.evaluate(() => window.engram.settingsGet().then(settings => [settings.defaultEngine, settings.aiSelections?.filing?.engine]))).toEqual(['codex', 'codex'])
  await access(join(vaultRoot, 'workspace', 'AGENTS.md'))
  await access(join(vaultRoot, 'private'))

  await expect.poll(() => page.evaluate(() => window.engram.enginesDetected())).toBe(true)
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const engines = ['claude', 'codex'].map(id => ({ id, installed: true, loggedIn: true, healthy: true }))
    ipcMain.removeHandler('engines:list')
    ipcMain.handle('engines:list', () => engines)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:changed', engines })
  })
  await expect(page.getByTestId('connect-banner')).toHaveCount(0)
  await expect(page.getByTestId('welcome-web')).toBeEnabled()
  await screenshot('05-first-screen.png')
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('sweep:run')
    const fixture = globalThis as typeof globalThis & { filingCalls: number }
    fixture.filingCalls = 0
    ipcMain.handle('sweep:run', async () => {
      fixture.filingCalls++
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'sweep:start' })
      await new Promise(resolve => setTimeout(resolve, 1500))
      const report = { executed: 1, skipped: 0, failed: 0, deferred: 0, briefWritten: false }
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'sweep:done', report })
      return report
    })
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'sweep:done', report: { executed: 0, skipped: 0, failed: 0, deferred: 13, haltReason: 'quota', briefWritten: false } })
  })
  await expect(page.getByTestId('sweep-status')).toContainText('usage limit')
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  await page.getByRole('region', { name: 'Filing model', exact: true }).getByTestId('model-picker').click()
  await expect(page.getByTestId('model-picker-menu')).toBeVisible()
  await page.getByTestId('provider-pick-codex').click()
  await expect.poll(() => page.evaluate(() => window.engram.settingsGet().then(settings => ({ filing: settings.aiSelections?.filing?.engine, chat: settings.defaultEngine })))).toEqual({ filing: 'codex', chat: 'codex' })
  await page.getByTestId('model-pick-auto').click()
  await page.getByTestId('settings-view').getByRole('button', { name: 'Done', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) => {
    const engines = ['claude', 'codex'].map(id => ({ id, installed: true, loggedIn: true, healthy: true }))
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:changed', engines })
  })
  await page.getByTestId('filing-retry').click()
  await expect(page.getByTestId('filing-retry')).toBeDisabled()
  await page.getByTestId('filing-retry').evaluate(button => (button as HTMLButtonElement).click())
  await expect(page.locator('.sidebar-work-status.working .sidebar-status-icon svg')).toBeVisible()
  await expect(page.getByTestId('sweep-status')).toContainText('Filing done')
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { filingCalls: number }).filingCalls)).toBe(1)
  await expect(page.getByTestId('filing-retry')).toBeEnabled()
  const retryBox = await page.getByTestId('filing-retry').boundingBox()
  const settingsBox = await page.getByTestId('activity-settings').boundingBox()
  expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(settingsBox!.x)
  expect(Math.abs(retryBox!.y + retryBox!.height / 2 - settingsBox!.y - settingsBox!.height / 2)).toBeLessThan(2)
  const conversationsBefore = await page.evaluate(() => window.engram.botsList().then(bots => bots.length))
  await page.setViewportSize({ width: 1100, height: 825 })
  await page.getByTestId('sidebar-create').click(); await page.getByTestId('bots-new').click()
  await page.getByTestId('welcome-input-add').click()
  await page.getByTestId('welcome-web').click()
  await page.locator('.browser-preview').getByRole('button', { name: 'Expand browser', exact: true }).click()
  await expect(page.getByTestId('live-address')).toBeFocused()
  await expect(page.locator('.bots-chat')).toBeHidden()
  await screenshot('06-browser-start.png')
  await expect(page.getByRole('navigation', { name: 'Website shortcuts' })).toHaveCount(0)
  await expect(page.locator('.web-pane-bar .live-address')).toHaveCount(1)
  await expect(page.locator('.browser-start')).toBeEmpty()
  await expect(page.getByTestId('connect-banner')).toBeHidden()
  await screenshot('07-browser-workspace.png')
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>Browser ready</h1>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
    const url = `http://127.0.0.1:${address.port}/private?code=not-stored`
    await page.getByTestId('live-address').fill(url)
    await page.getByTestId('live-address').press('Enter')
    await expect.poll(() => page.evaluate(() => window.engram.agentState().then(state => state.url)), { timeout: 60000 }).toBe(url)
    expect(await page.evaluate(() => window.engram.botsList().then(bots => bots.length))).toBe(conversationsBefore + 1)
    await page.getByTestId('web-pane-expand').click()
    await expect(page.locator('.bots-chat')).toBeVisible()
    await screenshot('07-browser-and-chat.png')
    await page.locator('.browser-preview').getByRole('button', { name: 'Expand browser', exact: true }).click()
    const lane = await page.evaluate(() => window.engram.agentState().then(state => state.lane!))
    await page.getByRole('button', { name: 'New tab', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByTestId('live-address')).toBeVisible()
    await page.getByRole('tab', { name: '127.0.0.1', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.engram.agentState().then(state => state.url))).toBe(url)
    const firstTabs = await page.evaluate(lane => window.engram.browserTabs(lane), lane)
    await page.getByTestId('sidebar-create').click(); await page.getByTestId('bots-new').click()
    await page.getByTestId('welcome-input-add').click()
    await page.getByTestId('welcome-web').click()
    await page.locator('.browser-preview').getByRole('button', { name: 'Expand browser', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    expect(await page.evaluate(lane => window.engram.browserTabs(lane), lane)).toEqual(firstTabs)
    await page.getByTestId(lane).click()
    await expect(page.getByRole('tab')).toHaveCount(2)
    await page.getByRole('button', { name: 'Close New tab', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await page.getByRole('button', { name: 'Close 127.0.0.1', exact: true }).click()
    await expect(page.getByTestId('live-address')).toBeVisible()
    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Website shortcuts' })).toHaveCount(0)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
