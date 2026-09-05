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
  // The page stands beside the conversation as its own pane, live at once.
  await expect(page.getByTestId('web-pane')).toBeVisible({ timeout: 60_000 })
  // The first window opens on a blank page; the address is asked for again
  // from the pane itself, which is what a person would do.
  await page.getByTestId('live-address').fill(siteUrl)
  await page.getByTestId('live-address').press('Enter')
  await expect(page.getByTestId('live-address')).toHaveValue(siteUrl, { timeout: 20_000 })
  const stage = page.getByTestId('web-pane').locator('.mirror-surface')
  await expect(stage.locator('canvas')).toBeVisible({ timeout: 15_000 })

  // Clicks are measured against the picture itself, so the test clicks the
  // canvas the way a person does.
  const screen = stage.locator('canvas')
  const box = (await screen.boundingBox())!
  await screen.click({ position: { x: box.width / 2, y: box.height * 0.2 } })
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}typed?q=hello`, { timeout: 15_000 })

  // A click on the mirror is a click on the page.
  await screen.click({ position: { x: box.width / 2, y: box.height * 0.2 } })
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}clicked`, { timeout: 15_000 })
})

test('mission control previews independent lanes and opens the chosen chat', async () => {
  const bots = await page.evaluate(async () => {
    const first = (await window.engram.botsList())[0]!
    const second = await window.engram.botCreate({ name: 'Parallel watch', purpose: '' })
    const third = await window.engram.botCreate({ name: 'Third watch', purpose: '' })
    const fourth = await window.engram.botCreate({ name: 'Fourth watch', purpose: '' })
    return [first, second, third, fourth]
  })
  await page.evaluate(async ({ url, ids }) => {
    await Promise.all(ids.map((id, index) => window.engram.agentGo(`${url}typed?q=${index + 2}`, `bot-${id}`)))
  }, { url: siteUrl, ids: bots.slice(1).map((bot) => bot.id) })
  const before = await page.evaluate(() => window.engram.agentState())
  const previews = await page.evaluate((ids) => window.engram.missionFrames(ids.map((id) => `bot-${id}`)), bots.map((bot) => bot.id))
  expect(previews[0]!.url).toBe(`${siteUrl}clicked`)
  expect(previews.slice(1).map((preview) => preview.url)).toEqual([2, 3, 4].map((index) => `${siteUrl}typed?q=${index}`))
  await expect.poll(async () => {
    const ready = await page.evaluate((ids) => window.engram.missionFrames(ids.map((id) => `bot-${id}`)), bots.map((bot) => bot.id))
    return ready.every((preview) => Boolean(preview.data))
  }, { timeout: 20000 }).toBe(true)
  expect(await page.evaluate(() => window.engram.agentState())).toEqual(before)
  await page.getByTestId('activity-mission').click()
  await expect(page.locator('.mission-tile')).toHaveCount(4)
  await expect(page.locator('.mission-preview img')).toHaveCount(4, { timeout: 15000 })
  await page.screenshot({ path: join(REPO_TMP, 'mission-live.png') })
  await page.getByTestId('mission-layout-2').click()
  await expect(page.locator('.mission-tile')).toHaveCount(2)
  await page.getByRole('button', { name: 'Open Parallel watch', exact: true }).click()
  await expect(page.locator('.bots-head-name')).toHaveText('Parallel watch')
  await page.locator('.bots-row', { hasText: 'Watching' }).click()
})

test('a saved wide page panel stays inside the conversation on a compact window', async () => {
  await page.evaluate(() => localStorage.setItem('engram.webpane.width', '1200'))
  await page.reload()
  await page.setViewportSize({ width: 948, height: 760 })
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  if (await page.getByTestId('app-sidebar-open').count()) await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId('activity-bots').click()
  await expect(page.getByTestId('web-pane')).toBeVisible({ timeout: 30_000 })

  const [mainBox, paneBox, foldBox, addressBox] = await Promise.all([
    page.locator('.bots-main').boundingBox(),
    page.getByTestId('web-pane').boundingBox(),
    page.getByTestId('web-pane-fold').boundingBox(),
    page.getByTestId('live-address').boundingBox(),
  ])
  expect(paneBox!.x).toBeGreaterThanOrEqual(mainBox!.x)
  expect(paneBox!.x + paneBox!.width).toBeLessThanOrEqual(mainBox!.x + mainBox!.width + 1)
  expect(foldBox!.x).toBeGreaterThanOrEqual(paneBox!.x)
  expect(addressBox!.x).toBeGreaterThan(foldBox!.x + foldBox!.width)
})
