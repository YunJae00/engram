import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault, listCards, listRoutines, type VaultPaths } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The routine replayer end to end: build a routine in the sheet (open a page,
// click a link, read what it says), run it against a local site, and find the
// reading waiting as a review card. This drives a REAL Chrome through the
// agent-browser — the whole point of the replayer is that no model runs.

test.describe.configure({ mode: 'serial' })

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

let app: ElectronApplication
let page: Page
let paths: VaultPaths
let server: Server
let siteUrl: string

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-routine-'))
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-routine-userdata-'))
  paths = await initVault(root, { git: false })

  // A local portal stand-in: a home page whose "Notices" link leads to the
  // text the routine is supposed to bring home.
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url === '/notices')
      res.end('<html><head><title>Notices</title></head><body><main><h1>Notices</h1><p>Holiday notice: the office closes early on Friday.</p></main></body></html>')
    else res.end('<html><head><title>Portal</title></head><body><main><h1>Portal</h1><a href="/notices">Notices</a></main></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the local site did not start')
  siteUrl = `http://127.0.0.1:${address.port}/`

  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      ENGRAM_USERDATA: userData,
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('the builder saves a routine a non-developer could author', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  // The sheet's door is a window intent (palette and future buttons fire the
  // same event); dispatch it directly once the shell listener is up.
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('engram:open-routines')))
    await expect(page.getByTestId('routines-sheet')).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })

  await page.getByTestId('routines-new').click()
  await page.getByTestId('routine-name').fill('Portal notices')
  await page.getByTestId('routine-step-url-0').fill(siteUrl)
  await page.getByTestId('routine-add-step').click()
  await page.getByTestId('routine-step-kind-1').selectOption('click')
  await page.getByTestId('routine-step-target-1').fill('Notices')
  await page.getByTestId('routine-add-step').click()
  await page.getByTestId('routine-step-kind-2').selectOption('read')
  await page.getByTestId('routine-save').click()

  // The saved routine appears as a runnable row, and is really on disk.
  await expect(page.locator('[data-testid^="routine-row-"]')).toHaveCount(1)
  await expect.poll(async () => (await listRoutines(paths)).map((r) => r.name)).toEqual(['Portal notices'])
})

test('running the routine drives a real Chrome and lands the reading in review', async () => {
  await page.locator('[data-testid^="routine-run-"]').click()
  // Live progress narrates the replay while Chrome does the walking.
  await expect(page.getByTestId('routine-live')).toBeVisible({ timeout: 15_000 })
  // Chrome cold-launch plus three steps: generous, then assert the product.
  await expect(page.getByTestId('routine-live')).toHaveCount(0, { timeout: 90_000 })

  await expect
    .poll(async () => (await listCards(paths)).map((c) => c.proposed).join('\n'), { timeout: 20_000 })
    .toContain('the office closes early on Friday')
  const routine = (await listRoutines(paths))[0]!
  expect(routine.lastOutcome).toBe('done')
})
