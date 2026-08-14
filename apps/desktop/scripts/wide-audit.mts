import { _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../tmp/overlap-vault/', import.meta.url))
const OUT = fileURLToPath(new URL('../../../tmp/wide-shots/', import.meta.url))

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
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1200)

  for (const width of [1920, 2400]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.waitForTimeout(500)
    const shot = (name: string) => page.screenshot({ path: join(OUT, `${width}-${name}.png`) })

    await page.getByTestId('activity-board').click()
    await page.waitForTimeout(600)
    await shot('board')

    await page.getByTestId('activity-brain').click()
    await page.waitForTimeout(500)
    const topic = page.getByTestId('brain-topic').first()
    if (await topic.count()) await topic.click()
    await page.waitForTimeout(500)
    // hover the first memory row so the hover background is in the shot
    const row = page.locator('.memory-row').first()
    if (await row.count()) await row.hover()
    await page.waitForTimeout(200)
    await shot('brain')

    await page.getByTestId('activity-list').click()
    await page.waitForTimeout(500)
    await shot('list')
  }
  await app.close()
  console.log('shots →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
