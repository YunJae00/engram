import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createBot, initVault } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The agent window's mirror inside the app: a lesson opens the large view
// on its own, an address typed there takes the window to the page, and the
// person's keys and clicks on the mirror land on that page — the frames
// coming back show it. The window itself sits off the screen throughout.

test.describe.configure({ mode: 'serial' })

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

let app: ElectronApplication
let page: Page
let server: Server
let siteUrl: string

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-live-'))
  const userData = await mkdtemp(join(REPO_TMP, 'e2e-live-userdata-'))
  // The mirror lives in a comet thread, so there has to be one to open.
  const paths = await initVault(root, { git: false })
  await createBot(paths, { name: 'Watching', purpose: '' })

  // A form that carries what was typed into its address, and a page whose
  // one link fills the top of the window so a click on the mirror finds it.
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    if (req.url?.startsWith('/typed'))
      res.end(
        '<html><head><title>Typed</title></head><body>' +
          '<a href="/clicked" style="position:fixed;left:0;top:0;width:100%;height:40%;display:block;background:#dfe">Back</a>' +
          '<main style="margin-top:45%"><h1>Typed</h1></main></body></html>',
      )
    else if (req.url === '/clicked') res.end('<html><head><title>Clicked</title></head><body><main><h1>Clicked</h1></main></body></html>')
    else
      res.end(
        '<html><head><title>Form</title></head><body><main><h1>Form</h1>' +
          '<form action="/typed"><input name="q" aria-label="Query" style="position:fixed;left:0;top:0;width:100%;height:40%;font-size:40px"/></form></main></body></html>',
      )
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

test('the mirror is watchable and acted in: the address, the keys and the clicks all reach the window', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.evaluate(async () => {
    const installed = (await window.engram.browsersInstalled()) as { path: string }[]
    if (installed[0]) await window.engram.browserChoose(installed[0].path)
  })
  // The app watches the agent browser and sends it to the page - the same
  // two calls the thread's live card makes when a comet opens something.
  await page.getByTestId('activity-bots').click()
  await page.locator('.bots-row', { hasText: 'Watching' }).click()
  await page.evaluate(() => window.engram.agentWatch(true))
  await page.evaluate((url) => window.engram.agentGo(url), siteUrl)
  await expect(page.getByTestId('live-card')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('live-expand').click()
  await expect(page.getByTestId('live-panel')).toBeVisible({ timeout: 30_000 })
  // The first window opens on a blank page; the address is asked for again
  // from the view itself, which is what a person would do.
  await page.getByTestId('live-address').fill(siteUrl)
  await page.getByTestId('live-address').press('Enter')
  await expect(page.getByTestId('live-address')).toHaveValue(siteUrl, { timeout: 20_000 })
  const stage = page.getByTestId('live-panel').locator('.live-stage')
  await expect(stage.locator('canvas')).toBeVisible({ timeout: 15_000 })

  // A click on the mirror focuses the page's field; keys typed there land in it.
  const box = (await stage.boundingBox())!
  await stage.click({ position: { x: box.width / 2, y: box.height * 0.2 } })
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}typed?q=hello`, { timeout: 15_000 })

  // A click on the mirror is a click on the page.
  await stage.click({ position: { x: box.width / 2, y: box.height * 0.2 } })
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}clicked`, { timeout: 15_000 })
})
