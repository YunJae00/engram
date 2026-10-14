import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

let app: ElectronApplication, page: Page
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'connection-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'connection-data-')), ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('engines:states')
    ipcMain.handle('engines:states', (_event, ids?: string[]) => (ids ?? ['claude', 'codex']).map(id => ({ id, installed: true, loggedIn: id === 'codex', conclusive: true })))
    ipcMain.removeHandler('engines:logins')
    ipcMain.handle('engines:logins', () => [{ id: 'claude', phase: 'connected', canOpen: false }])
  })
})
test.afterAll(async () => { await app?.close() })

test('a historical successful sign-in never overrides a signed-out probe', async () => {
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByTestId('brain-claude-status')).toHaveText('Not connected')
  await expect(page.getByTestId('brain-claude-connect')).toBeEnabled()
  await expect(page.getByTestId('brain-codex-status')).toHaveText('Connected')
  await expect(page.getByTestId('brain-codex-status')).toHaveAttribute('data-connected', 'true')
})

test('a stalled provider does not hold the other provider or spin forever', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('engines:states')
    ipcMain.handle('engines:states', (_event, ids?: string[]) => ids?.[0] === 'claude' ? new Promise(() => {}) : [{ id: 'codex', installed: true, loggedIn: true, conclusive: true }])
  })
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByTestId('brain-codex-status')).toHaveText('Connected')
  await expect(page.getByTestId('brain-claude-status')).toHaveText('Connection not verified', { timeout: 25_000 })
  await expect(page.getByTestId('brain-claude-status')).toHaveAttribute('data-connected', 'false')
  await expect(page.getByRole('button', { name: 'Retry connection check', exact: true })).toBeEnabled()
  await page.screenshot({ path: join(tmp, 'connection-not-verified.png') })
})

test('a known authentication failure stays visible in both settings and accounts despite local login metadata', async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('engines:states')
    ipcMain.handle('engines:states', (_event, ids?: string[]) => (ids ?? ['claude', 'codex']).map(id => ({ id, installed: true, loggedIn: true, conclusive: id !== 'codex', healthy: id !== 'codex', ...(id === 'codex' ? { healthReason: 'auth' } : {}) })))
    ipcMain.removeHandler('accounts:states')
    ipcMain.handle('accounts:states', () => [{ id: 'system', provider: 'codex', name: 'System account', selected: true, installed: true, loggedIn: true, conclusive: false, healthy: false, healthReason: 'auth' }])
  })
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-ai').click()
  await expect(page.getByTestId('brain-codex-status')).toHaveText('Reconnect required')
  await expect(page.getByTestId('brain-codex-status')).toHaveAttribute('data-connected', 'false')
  await expect(page.getByTestId('brain-codex-connect')).toBeEnabled()
  await page.getByRole('button', { name: 'Manage ChatGPT accounts', exact: true }).click()
  const accounts = page.getByRole('dialog', { name: 'Account profiles', exact: true })
  await expect(accounts.getByText('Reconnect required', { exact: true })).toBeVisible()
  await expect(accounts.getByRole('button', { name: 'Connect', exact: true })).toBeEnabled()
  await accounts.getByRole('button', { name: 'Close accounts', exact: true }).click()
})
