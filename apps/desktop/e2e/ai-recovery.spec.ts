import { expect, test, _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('remaining weekly usage does not hide a limited request and the chosen model can be retested', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const fixture = await mkdtemp(join(tmp, 'e2e-ai-recovery-'))
  await initVault(join(fixture, 'vault'), { git: false })
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: join(fixture, 'vault'), ENGRAM_USERDATA: join(fixture, 'profile'),
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.evaluate(async () => {
      await window.engram.settingsSet({ defaultEngine: 'codex', codexModel: 'quick' })
      await window.engram.aiSelectionSet('filing', { engine: 'codex', model: 'quick' })
    })
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      let limited = true, calls = 0
      const states = () => [{ id: 'claude', installed: false, loggedIn: false }, { id: 'codex', installed: true, loggedIn: true, healthy: !limited, ...(limited ? { healthReason: 'quota' } : {}) }]
      const tell = () => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'engines:changed', engines: states().filter(state => state.loggedIn) }) }
      const handle = (name: string, action: () => unknown) => { ipcMain.removeHandler(name); ipcMain.handle(name, action) }
      handle('engines:states', states)
      handle('accounts:list', () => ({ profiles: [], selected: { claude: 'system', codex: 'system' } }))
      handle('devUsage', () => ({ windows: [{ name: 'codex · 7d', used: 34 }], updatedAt: Date.now() }))
      handle('models:list', () => [{ value: 'quick', label: 'Quick', detail: 'Fixture' }])
      handle('ai:check', async () => {
        calls++; await new Promise(resolve => setTimeout(resolve, 200))
        if (calls === 1) throw new Error('ChatGPT is not ready. The provider limited this request.')
        limited = false; tell()
      })
      tell()
    })
    await expect(page.getByTestId('unhealthy-banner')).toContainText('ChatGPT limited a request')
    await expect(page.getByTestId('unhealthy-banner')).not.toContainText('once it resets')
    await page.getByTestId('unhealthy-banner').getByRole('button', { name: 'Check', exact: true }).click()
    await expect(page.getByTestId('settings-nav-ai')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('brain-codex-status')).toHaveText('Request limited · Retry check')
    await expect(page.getByText('66% remaining', { exact: true })).toBeVisible()
    await expect(page.getByText('Reported account limits. Model or short-term request limits may differ.', { exact: true })).toBeVisible()
    const check = page.getByTestId('ai-check-filing')
    await check.click()
    await expect(check).toBeDisabled()
    await expect(page.getByRole('alert')).toContainText('limited this request')
    await expect(page.getByTestId('brain-codex-status')).not.toHaveText('Connected')
    await check.click()
    await expect(page.getByText('The selected filing model answered successfully.', { exact: true })).toBeVisible()
    await expect(page.getByTestId('brain-codex-status')).toHaveText('Connected')
    await page.getByTestId('settings-view').getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.getByTestId('unhealthy-banner')).toHaveCount(0)
  } finally { await app.close() }
})
