import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const COPY: Record<string, { own: RegExp; others: RegExp }> = {
  win32: { own: /sign in to Windows/, others: /Mac|macOS|Linux/ },
  darwin: { own: /log in to your Mac/, others: /Windows|Linux/ },
  linux: { own: /when you sign in\./, others: /Windows|Mac|macOS/ },
}
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

test('auto-start description names only the current platform', async () => {
  const copy = COPY[process.platform] ?? COPY['linux']!
  await openActivity(page, 'settings')
  const item = page.locator('.settings-item', { has: page.getByTestId('setting-autostart') })
  await expect(item).toContainText(copy.own)
  expect(await item.innerText()).not.toMatch(copy.others)
})
