import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'

// Fresh home: the two onboarding screens, including the
// skip-AI path, land in a working shell.

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const PREVIEW = join(REPO_TMP, 'onboarding-preview')

let app: ElectronApplication
let page: Page
let vaultRoot: string
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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

test.afterEach(async () => {
  await app?.close()
})

test('a fresh workspace can skip AI and browse immediately', async () => {
  await expect(page.getByTestId('onboarding')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await page.getByTestId('onboard-next').click()
  await expect(page.getByTestId('onboard-skip-ai')).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Install Claude runtime' })).toBeVisible()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await page.getByTestId('onboard-next').click()
  await page.getByTestId('onboard-skip-ai').click()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60000 })
  await expect(page.getByTestId('web-new')).toBeEnabled()
  const titled = await page.evaluate(async () => {
    const bot = await window.engram.botCreate({ name: 'New comet', purpose: '' })
    await window.engram.chatSend({ message: 'Review the project plan', history: [], engineId: 'claude', botId: bot.id, channel: `bot-${bot.id}` })
    return (await window.engram.botsList()).find(row => row.id === bot.id)?.name
  })
  expect(titled).toBe('Review the project plan')
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
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
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
  })
  await page.getByTestId('onboard-next').click()

  // ② brain sign-in — the skip path goes straight in
  await expect(page.getByTestId('onboard-step-2')).toBeVisible()
  await expect(page.getByTestId('onboard-connect-codex')).toBeEnabled()
  await screenshot('02-connect-ai.png')
  await page.getByTestId('onboard-connect-claude').click()
  await expect(page.getByRole('alert')).toContainText('Sign-in did not finish')
  await page.getByTestId('onboard-connect-claude').click()
  await expect(page.getByRole('button', { name: 'Open browser', exact: true })).toBeVisible()
  await expect(page.getByTestId('onboard-skip-ai')).toBeDisabled()
  await screenshot('03-sign-in-waiting.png')
  await page.getByRole('button', { name: 'Cancel sign-in' }).click()
  await expect(page.getByTestId('onboard-connect-codex')).toBeEnabled()
  await page.getByTestId('onboard-connect-codex').click()
  await expect(page.getByTestId('onboard-brain-codex')).toHaveText('Connected')
  await expect.poll(() => page.evaluate(() => window.engram.settingsGet().then(settings => settings.aiSelections?.filing?.engine))).toBe('codex')
  await page.getByTestId('onboard-connect-claude').click()
  await expect(page.getByTestId('onboard-brain-claude')).toHaveText('Connected')
  await screenshot('04-connected.png')
  await page.getByTestId('onboard-finish').click()

  // lands in the shell on the new vault
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
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
  await expect(page.getByTestId('web-new')).toBeEnabled()
  await screenshot('05-first-screen.png')
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('sweep:run')
    ipcMain.handle('sweep:run', async () => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'sweep:start' })
      await new Promise(resolve => setTimeout(resolve, 300))
      const report = { executed: 1, skipped: 0, failed: 0, deferred: 0, briefWritten: false }
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'sweep:done', report })
      return report
    })
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'sweep:done', report: { executed: 0, skipped: 0, failed: 0, deferred: 13, haltReason: 'quota', briefWritten: false } })
  })
  await expect(page.getByTestId('sweep-status')).toContainText('usage limit')
  await page.getByTestId('engine-status').click()
  await expect(page.getByTestId('provider-picker-menu')).toContainText('Filing provider')
  await page.getByTestId('provider-pick-codex').click()
  await expect.poll(() => page.evaluate(() => window.engram.settingsGet().then(settings => ({ filing: settings.aiSelections?.filing?.engine, chat: settings.defaultEngine })))).toEqual({ filing: 'codex', chat: 'claude' })
  await page.getByTestId('model-pick-auto').click()
  await app.evaluate(({ BrowserWindow }) => {
    const engines = ['claude', 'codex'].map(id => ({ id, installed: true, loggedIn: true, healthy: true }))
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:changed', engines })
  })
  await page.getByTestId('filing-retry').click()
  await expect(page.getByTestId('sweep-status')).toContainText('Filing done')
  const retryBox = await page.getByTestId('filing-retry').boundingBox()
  const settingsBox = await page.getByTestId('activity-settings').boundingBox()
  expect(Math.abs(retryBox!.x - settingsBox!.x)).toBeLessThan(2)
  const conversationsBefore = await page.evaluate(() => window.engram.botsList().then(bots => bots.length))
  await page.getByTestId('web-new').click()
  await expect(page.getByTestId('browser-start-input')).toBeFocused()
  await expect(page.locator('.bots-chat')).toBeHidden()
  await screenshot('06-browser-start.png')
  await app.evaluate(({ BrowserWindow, ipcMain, nativeImage }) => {
    ipcMain.removeHandler('site:icon')
    ipcMain.handle('site:icon', (_event, origin: string) => {
      if (origin === 'https://docs.test') return null
      const colors = [0x4385d4, 0x34a078, 0xc55e78, 0x9070c5, 0xca9038]
      const color = colors[origin.length % colors.length]!
      const pixels = Buffer.alloc(16 * 16 * 4)
      for (let i = 0; i < 256; i++) {
        const white = i % 16 >= 5 && i % 16 <= 10 && Math.floor(i / 16) >= 4 && Math.floor(i / 16) <= 11
        pixels.writeUInt32LE(white ? 0xffffffff : (0xff000000 | color) >>> 0, i * 4)
      }
      return nativeImage.createFromBitmap(pixels, { width: 16, height: 16 }).toDataURL()
    })
    for (const name of ['notes', 'calendar', 'docs', 'mail', 'projects', 'tasks', 'files']) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'agent:live', on: true, lane: `fixture-${name}`, url: `https://${name}.test/private?token=not-stored` })
    }
  })
  const shortcuts = page.getByRole('navigation', { name: 'Website shortcuts' })
  await expect(shortcuts.getByRole('button')).toHaveCount(8)
  await expect(shortcuts.locator('img.site-icon')).toHaveCount(5)
  await expect(shortcuts.getByRole('button', { name: 'Open docs.test', exact: true }).locator('svg.site-icon')).toBeVisible()
  const boxes = await shortcuts.getByRole('button').evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { y: rect.y, height: rect.height } }))
  expect(new Set(boxes.map(box => box.y)).size).toBe(2)
  expect(boxes.every(box => box.height <= 32)).toBe(true)
  await screenshot('08-recent-sites.png')
  await expect(page.getByTestId('web-pane-expand')).toBeHidden()
  await page.getByRole('button', { name: 'Customize website shortcuts' }).click()
  await page.getByRole('textbox', { name: 'Website to pin' }).fill('https://pinned.example/private?token=excluded')
  await page.getByRole('button', { name: 'Pin website', exact: true }).click()
  await page.getByRole('button', { name: 'Save shortcuts' }).click()
  await expect(shortcuts.getByRole('button').first()).toHaveAttribute('aria-label', 'Open pinned.example')
  expect(await page.evaluate(() => localStorage.getItem('engram.pinnedWeb'))).toBe('["https://pinned.example"]')
  await expect(page.locator('.web-pane-bar .live-address')).toHaveCount(1)
  await expect(page.getByTestId('connect-banner')).toBeHidden()
  await screenshot('07-browser-workspace.png')
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>Browser ready</h1>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
    const url = `http://127.0.0.1:${address.port}/private?code=not-stored`
    await page.getByTestId('browser-start-input').fill(url)
    await page.getByTestId('browser-start-input').press('Enter')
    await expect.poll(() => page.evaluate(() => window.engram.agentState().then(state => state.url)), { timeout: 60000 }).toBe(url)
    expect(await page.evaluate(() => window.engram.botsList().then(bots => bots.length))).toBe(conversationsBefore)
    await expect(shortcuts.getByRole('button', { name: 'Open 127.0.0.1', exact: true })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('engram.recentWeb'))).not.toContain('not-stored')
    await expect(shortcuts.getByRole('button')).toHaveCount(8)
    await page.reload()
    await expect(shortcuts.getByRole('button')).toHaveCount(8)
    await expect(shortcuts.getByRole('button').first()).toHaveAttribute('aria-label', 'Open pinned.example')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
