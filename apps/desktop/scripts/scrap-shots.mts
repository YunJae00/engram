// Scrap-pile redesign check: board shots with 1 and 4 inbox captures.
// Run from apps/desktop:  ../../packages/core/node_modules/.bin/tsx scripts/scrap-shots.mts
import { _electron as electron } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/overlap-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/scrap-shots/', import.meta.url))

async function main(): Promise<void> {
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
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1500)
  await page.getByTestId('scrap-pile').waitFor({ state: 'visible', timeout: 10_000 })
  await page.screenshot({ path: join(OUT, 'scrap-1.png'), clip: { x: 0, y: 550, width: 420, height: 350 } })

  for (let i = 2; i <= 4; i++) {
    await writeFile(join(ROOT, 'workspace', 'inbox', `capture-${i}.md`), `캡처 메모 ${i} — 후속 확인 필요한 내용`)
  }
  await page.waitForTimeout(3500)
  await page.screenshot({ path: join(OUT, 'scrap-4.png'), clip: { x: 0, y: 550, width: 420, height: 350 } })
  await app.close()
  console.log('shots →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
