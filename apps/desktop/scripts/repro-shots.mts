// One-off reproduction harness: boots the app on an EXISTING vault (no seeding)
// and captures the curated board, expanded shelf and folder fan-out — for
// diagnosing layout overlap reports against a real user vault copied to tmp/.
// Run from apps/desktop:  ../../packages/core/node_modules/.bin/tsx scripts/repro-shots.mts <vault-root> <out-dir>
import { _electron as electron } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const VAULT = resolve(process.argv[2] ?? '../../tmp/repro-vault')
const OUT = resolve(process.argv[3] ?? '../../tmp/repro-shots')

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })
  const app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: VAULT,
      ENGRAM_USERDATA: join(VAULT, '.userdata'),
      ENGRAM_NO_GIT: '1',
      ENGRAM_ENGINE: 'none',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1500)

  const shot = async (name: string) => {
    try {
      await page.screenshot({ path: join(OUT, `${name}.png`), timeout: 60_000 })
      console.log('shot ok:', name)
    } catch (err) {
      console.error('shot FAILED:', name, String(err).slice(0, 120))
    }
  }

  await shot('01-curated')

  const shelf = page.getByTestId('board-shelf')
  if (await shelf.count()) {
    await shelf.locator('.shelf-head').click()
    await page.waitForTimeout(600)
    await shot('02-shelf-expanded')
    await shelf.locator('.shelf-head').click()
    await page.waitForTimeout(300)
  }

  const tile = page.getByTestId('rail-tile').first()
  if (await tile.count()) {
    await tile.click()
    await page.waitForTimeout(800)
    await shot('03-topic-panel')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }

  // List: sticky month header vs scrolled rows.
  await page.getByTestId('activity-list').click()
  await page.waitForTimeout(600)
  await page.locator('.list-scroll').evaluate((el) => { el.scrollTop = 60 })
  await page.waitForTimeout(300)
  await shot('08-list-scrolled')
  await page.getByTestId('activity-board').click()
  await page.waitForTimeout(400)

  // Brain view: topic pages built from the link graph.
  await page.getByTestId('activity-brain').click()
  await page.waitForTimeout(800)
  await shot('06-brain-topic')
  const unconnected = page.getByTestId('brain-unconnected')
  if (await unconnected.count()) {
    await unconnected.click()
    await page.waitForTimeout(500)
    await shot('07-brain-unconnected')
  }
  await page.getByTestId('brain-graph-open').click()
  await page.waitForTimeout(900)
  await shot('09-brain-constellation')
  // Clicking a node must close the overlay and open that note's sheet.
  await page.locator('[data-node-id]').first().click()
  await page.waitForTimeout(600)
  await shot('10-constellation-node-open')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.getByTestId('activity-board').click()
  await page.waitForTimeout(500)

  // Resize behaviour: the help button must ride its corner, the constellation
  // sheet must stay centered and scale.
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.waitForTimeout(700)
  await shot('11-resized-large')
  await page.getByTestId('activity-brain').click()
  await page.waitForTimeout(400)
  await page.getByTestId('brain-graph-open').click()
  await page.waitForTimeout(800)
  await shot('12-constellation-large')
  await page.keyboard.press('Escape')
  await page.getByTestId('activity-board').click()
  await page.waitForTimeout(400)

  // A short window is where the shelf/folder collisions were reported.
  await page.setViewportSize({ width: 1100, height: 640 })
  await page.waitForTimeout(800)
  await shot('04-short-window')
  if (await shelf.count()) {
    await shelf.locator('.shelf-head').click()
    await page.waitForTimeout(600)
    await shot('05-short-shelf-expanded')
  }

  await app.close()
  console.log('shots →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
