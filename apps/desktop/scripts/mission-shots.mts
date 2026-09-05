import { _electron as electron, expect } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const temp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(temp, { recursive: true })
const vault = await mkdtemp(join(temp, 'mission-vault-'))
const userData = await mkdtemp(join(temp, 'mission-user-'))
await initVault(vault, { git: false })
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
})
try {
  const page = await app.firstWindow()
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60000 })
  for (const name of ['Research scout', 'Release review', 'Weekly planning', 'Inbox assistant']) {
    await page.evaluate((name) => window.engram.botCreate({ name, purpose: 'Ready to work alongside your other comets.' }), name)
  }
  await page.getByTestId('activity-mission').click()
  await page.getByRole('button', { name: 'Open Research scout', exact: true }).waitFor()
  for (const width of [1280, 948, 620]) {
    await page.setViewportSize({ width, height: 840 })
    if (width === 620) {
      await page.getByTestId('app-sidebar-close').click()
      await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'true')
    }
    await page.screenshot({ path: join(temp, `mission-${width}.png`) })
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.screenshot({ path: join(temp, 'mission-dark.png') })
} finally { await app.close() }
