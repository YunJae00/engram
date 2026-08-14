// Empty-state audit: boots on a FRESH vault and captures every canvas tab so
// the shared empty grammar can be reviewed at a glance.
// Run from apps/desktop:  ../../packages/core/node_modules/.bin/tsx scripts/empty-shots.mts
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/empty-shots/', import.meta.url))

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'empty-'))
  await initVault(root, { git: false })

  const app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_NO_GIT: '1', ENGRAM_ENGINE: 'none' },
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1000)

  for (const tab of ['board', 'brain', 'list']) {
    await page.getByTestId(`activity-${tab}`).click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(OUT, `empty-${tab}.png`) })
    console.log('shot ok:', tab)
  }

  await app.close()
  console.log('shots →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
