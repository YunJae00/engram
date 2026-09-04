// Empty-vault sweep: every tab's empty state on a brand-new vault.
// Run from apps/desktop:  ../../packages/core/node_modules/.bin/tsx scripts/empty-tabs-shots.mts
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/sky-empty-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/empty-tabs/', import.meta.url))

await rm(ROOT, { recursive: true, force: true })
await initVault(ROOT, { git: false })
await mkdir(OUT, { recursive: true })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: {
    ...process.env,
    ENGRAM_VAULT: ROOT,
    ENGRAM_USERDATA: join(ROOT, '.userdata'),
    ENGRAM_NO_GIT: '1',
    ENGRAM_ENGINE: 'none',
  },
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(1200)

for (const tab of ['bots', 'sky', 'list']) {
  await page.getByTestId(`activity-${tab}`).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(OUT, `empty-${tab}.png`) })
  console.log('shot:', tab)
}
await app.close()
console.log('shots →', OUT)
