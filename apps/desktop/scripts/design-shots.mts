// Design-review harness: boots the app on a vault seeded with the Korean
// starter pack and captures the surfaces a designer needs to see. Dev-only —
// run from apps/desktop with:  ../../packages/core/node_modules/.bin/tsx scripts/design-shots.mts
import { _electron as electron } from '@playwright/test'
import { initVault, runImport } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
const SAMPLES = fileURLToPath(new URL('../../../samples/starter-vault-ko/', import.meta.url))
const OUT = process.env['SHOT_DIR'] ?? fileURLToPath(new URL('../../../tmp/design-shots/', import.meta.url))

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'design-'))
  const paths = await initVault(root, { git: false })
  await runImport(paths, SAMPLES)
  console.log('vault:', root)

  const app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      // Isolated userData: localStorage (board mode etc.) must not leak
      // between harness runs or the default-mode scenes lie.
      ENGRAM_USERDATA: join(root, '.userdata'),
      ENGRAM_NO_GIT: '1',
      ENGRAM_ENGINE: 'none',
    },
  })
  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(1500) // notes render, migration settles

  // Per-shot isolation: a hung font/paint wait must not kill the whole run.
  const shot = async (name: string) => {
    try {
      await page.screenshot({ path: join(OUT, `${name}.png`), timeout: 60_000 })
      console.log('shot ok:', name)
    } catch (err) {
      console.error('shot FAILED:', name, String(err).slice(0, 120))
    }
  }

  await shot('01-curated-default-light') // curated is the new default mode

  // folder fan-out: the 43-note sample vault yields at least one curated folder;
  // clicking it fans its member cards out on the board.
  const folder = page.getByTestId('board-folder').first()
  if (await folder.count()) {
    await folder.scrollIntoViewIfNeeded().catch(() => undefined)
    await folder.click()
    await page.waitForTimeout(800)
    await shot('02-folder-fanout-light')
    await folder.click() // collapse before leaving curated mode
    await page.waitForTimeout(300)
  }

  // everything-else shelf: the 43-note sample vault collapses its loose notes into
  // one stack; clicking it unfolds the ledger-grammar row list in place. Stays in
  // curated mode — a chance to confirm the composition fills one viewport.
  const shelf = page.getByTestId('board-shelf')
  if (await shelf.count()) {
    await shelf.scrollIntoViewIfNeeded().catch(() => undefined)
    await shelf.locator('.shelf-head').click()
    await page.waitForTimeout(600)
    await shot('02b-shelf-expanded-light')
    await shelf.locator('.shelf-head').click() // collapse before leaving curated mode
    await page.waitForTimeout(300)
  }

  // hover preview on some card
  const firstCard = page.locator('[data-board-note]').first()
  await firstCard.hover()
  await page.waitForTimeout(700)
  await shot('04-hover-preview')
  await page.mouse.move(10, 400)
  await page.waitForTimeout(300)

  // brief paper interaction (the centered-modal complaint)
  const brief = page.locator('.brief-paper').first()
  if (await brief.count()) {
    await brief.click()
    await page.waitForTimeout(500)
    await shot('05-brief-open')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }

  // note sheet: source editor font check (dblclick a card opens the note)
  await page.locator('[data-board-note]').first().dblclick()
  await page.waitForTimeout(900)
  await shot('05-note-editor')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // today sheet (renders latest brief or the empty state)
  await page.getByTestId('today-button').click()
  await page.waitForTimeout(500)
  await shot('05b-today-sheet')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // chat panel
  await page.keyboard.press('Control+l')
  await page.waitForTimeout(500)
  await shot('06-chat')
  await page.keyboard.press('Control+l')
  await page.waitForTimeout(300)

  // list view
  await page.getByTestId('activity-list').click()
  await page.waitForTimeout(600)
  await shot('07-list')
  await page.getByTestId('activity-board').click().catch(() => undefined)
  await page.waitForTimeout(400)

  // dark theme
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(600)
  await shot('08-board-dark')

  await app.close()
  console.log('shots →', OUT)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
