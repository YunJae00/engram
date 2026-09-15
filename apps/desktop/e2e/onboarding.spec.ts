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
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await page.getByTestId('onboard-next').click()
  await expect(page.getByTestId('onboard-skip-ai')).toBeEnabled()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByTestId('vault-root-input')).toHaveValue(vaultRoot)
  await page.getByTestId('onboard-next').click()
  await page.getByTestId('onboard-skip-ai').click()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60000 })
  await expect(page.getByTestId('web-new')).toBeEnabled()
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
  await page.getByTestId('web-new').click()
  await expect(page.getByTestId('browser-start-input')).toBeFocused()
  await expect(page.locator('.bots-chat')).toBeHidden()
  await screenshot('06-browser-start.png')
  await app.evaluate(({ BrowserWindow }) => {
    for (const name of ['notes', 'calendar', 'docs', 'mail', 'projects', 'tasks', 'files']) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'agent:live', on: true, lane: `fixture-${name}`, url: `https://${name}.test/private?token=not-stored` })
    }
  })
  await expect(page.getByRole('navigation', { name: 'Recent websites' }).getByRole('button')).toHaveCount(8)
  await screenshot('08-recent-sites.png')
  await page.getByTestId('web-pane-expand').click()
  await expect(page.locator('.bots-chat')).toBeVisible()
  await screenshot('07-browser-and-chat.png')
  await page.getByTestId('web-pane-expand').click()
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>Browser ready</h1>') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address')
    const url = `http://127.0.0.1:${address.port}/private?code=not-stored`
    await page.getByTestId('browser-start-input').fill(url)
    await page.getByTestId('browser-start-input').press('Enter')
    await expect.poll(() => page.evaluate(() => window.engram.agentState().then(state => state.url)), { timeout: 60000 }).toBe(url)
    await expect(page.getByRole('navigation', { name: 'Recent websites' }).getByTitle(`http://127.0.0.1:${address.port}`, { exact: true })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('engram.recentWeb'))).not.toContain('not-stored')
    await expect(page.getByRole('navigation', { name: 'Recent websites' }).getByRole('button')).toHaveCount(8)
    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Recent websites' }).getByRole('button')).toHaveCount(8)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
