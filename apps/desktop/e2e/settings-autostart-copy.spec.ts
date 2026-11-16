import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page

test.beforeEach(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'autostart-copy-vault-'))
  await initVault(vault, { git: false })
  const env = { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'autostart-copy-userdata-')), ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' }
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env })
  page = await app.firstWindow({ timeout: 60_000 })
  await expect(page.getByTestId('shell')).toBeVisible()
})
test.afterEach(async () => { await closeTestApp(app) })

test('auto-start has no Settings row and is on by default', async () => {
  await openActivity(page, 'settings')
  const settings = page.getByTestId('settings-view')
  await expect(settings.getByTestId('settings-theme')).toBeVisible()
  await expect(settings.getByTestId('setting-autostart')).toHaveCount(0)
  await expect(settings).not.toContainText(/sign in to Windows|log in to your Mac|when you sign in\./)
  expect(await page.evaluate(() => window.engram.settingsGet().then(value => value.autoStart))).toBe(true)
})
