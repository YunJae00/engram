// Engram sky check: home boots into the constellation; empty vault shows the
// starter sky. Run from apps/desktop:
//   ../../packages/core/node_modules/.bin/tsx scripts/sky-shots.mts
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEEDED = fileURLToPath(new URL('../../../tmp/overlap-vault/', import.meta.url))
const EMPTY = fileURLToPath(new URL('../../../tmp/sky-empty-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/sky-shots/', import.meta.url))

async function shoot(vault: string, name: string): Promise<void> {
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: vault,
      ENGRAM_USERDATA: join(vault, '.userdata'),
      ENGRAM_NO_GIT: '1',
      ENGRAM_ENGINE: 'none',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1800)
  await page.screenshot({ path: join(OUT, `${name}.png`) })
  await app.close()
  console.log('shot:', name)
}

await mkdir(OUT, { recursive: true })
await shoot(SEEDED, 'sky-seeded')
await rm(EMPTY, { recursive: true, force: true })
await initVault(EMPTY, { git: false })
await shoot(EMPTY, 'sky-empty')
console.log('shots →', OUT)
