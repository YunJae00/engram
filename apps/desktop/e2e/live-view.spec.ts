import { expect, test, chromium, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { openActivity } from './navigation.js'
import { createBot, initVault } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
let browserPort: number
const requests = new Map<string, number>()

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
    requests.set(req.url ?? '/', (requests.get(req.url ?? '/') ?? 0) + 1)
    res.setHeader('content-type', 'text/html')
    if (req.url?.startsWith('/typed'))
      res.end(
        '<html><head><title>Typed</title></head><body>' +
          '<a href="/clicked" style="position:fixed;left:0;top:0;width:100%;height:40%;display:block;background:#dfe">Back</a>' +
          '<main style="margin-top:45%"><h1>Typed</h1></main></body></html>',
      )
    else if (req.url === '/scroll') res.end('<html><body style="margin:0"><div style="height:3000px;background:rgb(240,40,40)"></div><div style="height:6000px;background:rgb(30,80,220)"></div></body></html>')
    else if (req.url === '/motion') res.end('<html><body><h1>Sharp moving page</h1><div id="box" style="width:200px;height:200px;background:#3478f6"></div><script>function move(t){document.getElementById("box").style.transform="translateX("+(t/5%500)+"px)";requestAnimationFrame(move)}requestAnimationFrame(move)</script></body></html>')
    else if (req.url === '/clicked' || req.url === '/popup') res.end('<html><head><title>Clicked</title></head><body><main><h1>Clicked</h1></main></body></html>')
    else
      res.end(
        '<html><head><title>Form</title></head><body style="min-height:4000px"><main><h1>Form</h1>' +
          '<form action="/typed"><input name="q" aria-label="Query" style="position:fixed;left:0;top:0;width:100%;height:40%;font-size:40px"/></form>' +
          '<a href="/popup" target="_blank" style="position:fixed;left:0;top:50%;width:100%;height:30%;display:block">Open popup</a></main></body></html>',
      )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the local site did not start')
  siteUrl = `http://127.0.0.1:${address.port}/`
  const portProbe = createServer()
  await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
  const probeAddress = portProbe.address()
  if (!probeAddress || typeof probeAddress === 'string') throw new Error('no browser test port')
  browserPort = probeAddress.port
  await new Promise<void>((resolve) => portProbe.close(() => resolve()))

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
      ENGRAM_AGENT_CDP: String(browserPort),
      ENGRAM_BROWSER_EXTERNAL: '1',
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
})

test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('browser controls navigate history, reload the website and open imported bookmarks', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: 'Watching' }).click()
  const lane = await page.evaluate(async () => `bot-${(await window.engram.botsList()).find((bot) => bot.name === 'Watching')!.id}`)
  await page.evaluate(async ({ lane, url }) => {
    await window.engram.agentGo(url, lane)
    await window.engram.agentGo(`${url}clicked`, lane)
  }, { lane, url: siteUrl })
  const pane = page.getByTestId('web-pane')
  await expect(pane).toBeVisible({ timeout: 60000 })
  await expect(pane.getByRole('button', { name: 'Back', exact: true })).toBeEnabled()
  await pane.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByTestId('live-address')).toHaveValue(siteUrl)
  await pane.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}clicked`)
  const before = requests.get('/clicked') ?? 0
  await pane.getByRole('button', { name: 'Reload page', exact: true }).click()
  await expect.poll(() => requests.get('/clicked') ?? 0).toBeGreaterThan(before)
  await expect(pane.getByTestId('live-reset')).toHaveCount(0)
  await app.evaluate(({ ipcMain }, url) => {
    ipcMain.removeHandler('bookmarks:sources'); ipcMain.removeHandler('bookmarks:list'); ipcMain.removeHandler('bookmarks:import')
    ipcMain.handle('bookmarks:sources', () => [{ id: 'fixture', name: 'Chrome · Test profile' }])
    ipcMain.handle('bookmarks:list', () => [])
    ipcMain.handle('bookmarks:import', () => [{ title: 'Fixture bookmark', url, folder: 'Work' }])
  }, siteUrl)
  await pane.getByRole('button', { name: 'Bookmarks', exact: true }).click()
  const bookmarks = page.getByRole('dialog', { name: 'Bookmarks', exact: true })
  await bookmarks.getByRole('button', { name: 'Chrome · Test profile' }).click()
  await bookmarks.getByRole('button', { name: /Fixture bookmark/ }).click()
  await expect(bookmarks).toHaveCount(0)
  await expect(page.getByTestId('live-address')).toHaveValue(siteUrl)
})

test('the mirror is watchable and acted in: the address, the keys and the clicks all reach the window', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.browsersInstalled().then((items) => items.length).catch(() => 0))).toBeGreaterThan(0)
  await page.evaluate(async () => {
    const installed = (await window.engram.browsersInstalled()) as { path: string }[]
    if (installed[0]) await window.engram.browserChoose(installed[0].path)
  })
  // The app watches the agent browser and sends it to the page - the same
  // two calls the thread's live card makes when a comet opens something.
  await openActivity(page, 'bots')
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
  // A person clicks what they can see: a canvas nothing has landed on yet
  // drops the click, so the picture has to be there first.
  await expect(stage.locator('canvas[data-painted]')).toBeVisible({ timeout: 15_000 })

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
  }, { timeout: 30000 }).toBe(true)
  expect(await page.evaluate(() => window.engram.agentState())).toEqual(before)
  await openActivity(page, 'mission')
  await expect(page.locator('.mission-tile')).toHaveCount(4)
  // Nothing is running in this vault, so the seats are open pluses; seat
  // two chats by hand and watch their pages arrive beside their chats.
  await page.getByTestId('mission-add-0').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Parallel watch' }).click()
  await page.getByTestId('mission-add-1').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Third watch' }).click()
  await expect(page.locator('.mission-preview canvas[data-painted]')).toHaveCount(2, { timeout: 15000 })
  const previewWidths = () => page.locator('.mission-preview canvas').evaluateAll((nodes) => nodes.map((node) => (node as HTMLCanvasElement).width))
  const expectedWidths = () => page.locator('.mission-preview').evaluateAll((nodes) => nodes.map((node) => Math.max(360, Math.min(1920, Math.round(node.getBoundingClientRect().width / 8) * 8)) * 2))
  await expect.poll(previewWidths, { timeout: 15000 }).toEqual(await expectedWidths())
  await expect(page.locator('.mini-chat')).toHaveCount(2)
  await page.getByTestId('mission-add-2').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Watching', exact: true }).click()
  await page.getByTestId('mission-add-3').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Fourth watch', exact: true }).click()
  await expect(page.locator('.mission-preview canvas[data-painted]')).toHaveCount(4, { timeout: 20000 })
  await expect.poll(previewWidths, { timeout: 20000 }).toEqual(await expectedWidths())
  const simultaneous = await page.evaluate(async ({ url, ids }) => {
    const lanes = ids.map((id) => `bot-${id}`)
    const counts = lanes.map(() => 0)
    let measuring = false
    const off = window.engram.onEvent((event) => {
      if (!measuring || event.type !== 'mission:frame' || !event.frame.data) return
      const index = lanes.indexOf(event.frame.lane)
      if (index >= 0) counts[index]!++
    })
    try {
      await Promise.all(lanes.map((lane) => window.engram.agentGo(`${url}motion`, lane)))
      await new Promise((resolve) => setTimeout(resolve, 1000))
      measuring = true
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return counts
    } finally {
      off()
      await Promise.all(lanes.map((lane, index) => window.engram.agentGo(`${url}typed?q=${index}`, lane)))
    }
  }, { url: siteUrl, ids: bots.map((bot) => bot.id) })
  console.log('simultaneous motion frames in 3s:', simultaneous)
  expect(simultaneous.every((count) => count > 15)).toBe(true)
  // The CDP screenshot stalls on a hidden window that repaints on a timer;
  // the app's own capture path does not, so the picture is taken there. A
  // hidden window stops presenting frames, and a capture returns the last
  // presented one — so a first capture wakes the compositor and a second,
  // after a beat, gets the current render.
  const shot = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((one) => !one.isDestroyed() && one.webContents.getURL().includes('index.html'))
    if (!win) throw new Error('no app window to photograph')
    await win.webContents.capturePage()
    await new Promise((resolve) => setTimeout(resolve, 400))
    return (await win.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(REPO_TMP, 'mission-live.png'), Buffer.from(shot, 'base64'))
  await page.getByTestId('mission-layout-2').click()
  await expect(page.locator('.mission-tile')).toHaveCount(2)
  // A title picker replaces this exact seat, not the first available one.
  await page.getByRole('button', { name: 'Chat for panel 2', exact: true }).click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: 'Fourth watch', exact: true }).click()
  await expect(page.getByTestId('mission-tile-1').locator('.mission-name')).toHaveText('Fourth watch')
  const motion = await page.evaluate(async ({ url, id }) => {
    let count = 0
    const off = window.engram.onEvent((event) => { if (event.type === 'mission:frame' && event.frame.lane === `bot-${id}` && event.frame.data) count++ })
    await window.engram.agentGo(`${url}motion`, `bot-${id}`)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    off()
    return count
  }, { url: siteUrl, id: bots[3]!.id })
  expect(motion).toBeGreaterThan(10)
  await page.getByRole('button', { name: 'Open Parallel watch', exact: true }).first().click()
  await expect(page.locator('.bots-head-name')).toHaveText('Parallel watch')
  await openActivity(page, 'mission')
  await expect(page.getByTestId('mission-tile-0').locator('.mission-name')).toHaveText('Parallel watch')
  await expect(page.getByTestId('mission-tile-1').locator('.mission-name')).toHaveText('Fourth watch')
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60000 })
  await openActivity(page, 'mission')
  await expect(page.getByTestId('mission-tile-1').locator('.mission-name')).toHaveText('Fourth watch')
  await page.getByRole('button', { name: 'Open Fourth watch', exact: true }).first().click()
  await expect(page.locator('.bots-head-name')).toHaveText('Fourth watch')
  await page.setViewportSize({ width: 1680, height: 950 })
  await page.evaluate(({ url, id }) => window.engram.agentGo(`${url}scroll`, `bot-${id}`), { url: siteUrl, id: bots[3]!.id })
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}scroll`)
  await page.getByTestId('web-pane').evaluate(async (node) => { await Promise.all(node.getAnimations().map((animation) => animation.finished)) })
  await page.evaluate(async (lane) => {
    const rect = document.querySelector('.web-pane-stage')!.getBoundingClientRect()
    const width = Math.round(rect.width / 8) * 8, height = Math.round(rect.height / 8) * 8
    for (let resize = 0; resize < 8; resize++) {
      await Promise.all([window.engram.agentResize(lane, width - 64, height), window.engram.agentRefresh()])
      await Promise.all([window.engram.agentResize(lane, width, height), window.engram.agentRefresh()])
    }
  }, `bot-${bots[3]!.id}`)
  const sharpWidth = await page.locator('.web-pane-stage').evaluate((node) => Math.max(360, Math.min(1920, Math.round(node.getBoundingClientRect().width / 8) * 8)) * 2)
  // Navigation commits before the new document can receive wheel input.
  try {
    await expect.poll(() => page.getByTestId('web-pane').locator('canvas').evaluate((node) => {
      const canvas = node as HTMLCanvasElement
      const pixel = canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
      return { format: canvas.dataset.format, width: canvas.width, pixel: Array.from(pixel) }
    }), { timeout: 20000 }).toEqual({ format: 'png', width: sharpWidth, pixel: [240, 40, 40, 255] })
    await page.evaluate((id) => window.engram.agentInput({ kind: 'mouse', type: 'wheel', x: 0.5, y: 0.5, deltaY: 4000, deltaX: 0 }, `bot-${id}`), bots[3]!.id)
    await expect.poll(() => page.getByTestId('web-pane').locator('canvas').evaluate((node, width) => {
      const canvas = node as HTMLCanvasElement
      const pixel = canvas.getContext('2d')!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data
      return canvas.dataset.format === 'png' && canvas.width === width && pixel[2]! > 180 && pixel[0]! < 60
    }, sharpWidth), { timeout: 20000 }).toBe(true)
  } catch (error) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`)
    try {
      const actual = browser.contexts()[0]!.pages().find((entry) => entry.url() === `${siteUrl}scroll`)!
      const cdp = await actual.context().newCDPSession(actual)
      console.log('capture diagnostics', JSON.stringify({ viewport: actual.viewportSize(), metrics: await cdp.send('Page.getLayoutMetrics'), document: await actual.evaluate(() => ({ width: innerWidth, height: innerHeight, y: scrollY, scale: devicePixelRatio, html: document.body.innerHTML })) }))
      const mirror = await page.getByTestId('web-pane').locator('canvas').evaluate((node) => (node as HTMLCanvasElement).toDataURL().split(',')[1]!)
      await test.info().attach('mirrored-page', { body: Buffer.from(mirror, 'base64'), contentType: 'image/png' })
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      await test.info().attach('direct-page', { body: Buffer.from(shot.data, 'base64'), contentType: 'image/png' })
      await cdp.detach()
    } finally { await browser.close() }
    throw error
  }
  await page.locator('.bots-row', { hasText: 'Watching' }).click()
})

test('a saved wide page panel stays inside the conversation on a compact window', async () => {
  await page.evaluate(() => localStorage.setItem('engram.webpane.width', '1200'))
  await page.reload()
  await page.setViewportSize({ width: 948, height: 760 })
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  if (await page.getByTestId('app-sidebar-open').count()) await page.getByTestId('app-sidebar-open').click()
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: 'Watching' }).click()
  await expect(page.getByTestId('web-pane')).toBeVisible({ timeout: 30_000 })

  await expect(page.getByTestId('web-pane')).toHaveCSS('transform', 'none')
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

test('window and chat handoffs preserve independent input, composition and monitoring', async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${browserPort}`)
  try {
    const context = browser.contexts()[0]!
    const pages = context.pages().filter((one) => one.url().startsWith(siteUrl))
    expect(pages).toHaveLength(4)
    const windowIds = await Promise.all(pages.map(async (one) => {
      const cdp = await context.newCDPSession(one)
      try { return (await cdp.send('Browser.getWindowForTarget')).windowId } finally { await cdp.detach() }
    }))
    expect(new Set(windowIds).size).toBe(4)
    const bots = await page.evaluate(() => window.engram.botsList())
    const first = bots.find((bot) => bot.name === 'Watching')!
    const second = bots.find((bot) => bot.name === 'Parallel watch')!
    await page.evaluate(async ({ url, first, second }) => {
      await Promise.all([
        window.engram.agentGo(`${url}?lane=first`, `bot-${first}`),
        window.engram.agentGo(`${url}?lane=second`, `bot-${second}`),
      ])
    }, { url: siteUrl, first: first.id, second: second.id })
    // Navigation on the app's connection can finish before this observer receives it.
    await expect.poll(() => context.pages().map((one) => one.url())).toEqual(expect.arrayContaining([`${siteUrl}?lane=first`, `${siteUrl}?lane=second`]))
    const firstPage = context.pages().find((one) => one.url() === `${siteUrl}?lane=first`)!
    const secondPage = context.pages().find((one) => one.url() === `${siteUrl}?lane=second`)!
    await expect(firstPage.locator('input')).toBeVisible()
    await expect(secondPage.locator('input')).toBeVisible()
    const clickInput = async () => {
      const canvas = page.getByTestId('web-pane').locator('canvas[data-painted]')
      await expect(canvas).toBeVisible()
      const point = await canvas.evaluate((node) => {
        const surface = node as HTMLCanvasElement, box = surface.getBoundingClientRect()
        const scale = Math.min(box.width / surface.width, box.height / surface.height)
        return { x: box.width / 2, y: (box.height - surface.height * scale) / 2 + surface.height * scale * 0.2 }
      })
      await canvas.click({ position: point })
    }
    await page.locator('.bots-row', { hasText: 'Watching' }).click()
    await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}?lane=first`)
    await clickInput()
    const keys = page.getByTestId('web-pane').locator('.live-keys')
    await keys.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      node.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '한글' }))
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한글' }))
    })
    await page.keyboard.insertText(' 입력 123')
    await expect(firstPage.locator('input')).toHaveValue('한글 입력 123')
    for (let turn = 0; turn < 3; turn++) {
      await page.locator('.bots-row', { hasText: 'Parallel watch' }).click()
      await page.locator('.bots-row', { hasText: 'Watching' }).click()
    }
    await page.locator('.bots-row', { hasText: 'Parallel watch' }).click()
    await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}?lane=second`)
    await clickInput()
    await page.evaluate((id) => window.engram.agentInput({ kind: 'text', text: 'stale' }, `bot-${id}`), first.id)
    await page.keyboard.type('second')
    await expect(secondPage.locator('input')).toHaveValue('second')
    await expect(firstPage.locator('input')).toHaveValue('한글 입력 123')
    await firstPage.evaluate(() => window.scrollTo(0, 360))
    await secondPage.evaluate(() => window.scrollTo(0, 720))
    for (let turn = 0; turn < 3; turn++) {
      await openActivity(page, 'mission')
      await expect(page.locator('.mission-preview canvas[data-painted]')).toHaveCount(2)
      await page.getByRole('button', { name: 'Open Parallel watch', exact: true }).first().click()
      await expect(page.getByTestId('web-pane').locator('canvas[data-painted]')).toBeVisible()
    }
    await clickInput()
    await page.keyboard.press('End')
    await page.keyboard.insertText(' 유지')
    await expect(secondPage.locator('input')).toHaveValue('second 유지')
    expect(await firstPage.evaluate(() => window.scrollY)).toBe(360)
    expect(await secondPage.evaluate(() => window.scrollY)).toBe(720)
    const opened = secondPage.waitForEvent('popup')
    await secondPage.getByRole('link', { name: 'Open popup' }).click()
    const popup = await opened
    await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}popup`)
    await popup.close()
    await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}?lane=second`)
    await expect(secondPage.locator('input')).toHaveValue('second 유지')
  } finally { await browser.close() }
})

test('web phases auto-open only their own conversation and folds never leak across chats', async () => {
  const bots = await page.evaluate(() => window.engram.botsList())
  const first = `bot-${bots.find((bot) => bot.name === 'Watching')!.id}`
  const second = `bot-${bots.find((bot) => bot.name === 'Parallel watch')!.id}`
  await app.evaluate(({ ipcMain }, lanes) => {
    ipcMain.removeHandler('chat:active')
    ipcMain.handle('chat:active', () => lanes)
  }, [first, second])
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: 'Watching' }).click()
  const step = (channel: string, tool: string) => app.evaluate(({ BrowserWindow }, { channel, tool }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'comet:step', channel, line: `${tool}: page` })
  }, { channel, tool })
  const pane = page.getByTestId('web-pane')
  await expect(pane).toBeVisible()
  await page.getByTestId('web-pane-fold').click()
  await expect(pane).toHaveCount(0)
  await step(first, 'open_page')
  await expect(pane).toBeVisible()
  await expect(pane.getByTestId('web-work-status')).toHaveAttribute('aria-hidden', 'false')
  await expect(pane).toHaveAttribute('data-work', 'working')
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}?lane=first`)
  await step(first, 'aside')
  await expect(pane.getByTestId('web-work-status')).toContainText('You have the page')
  await step(first, 'resume')
  await page.getByTestId('web-pane-fold').click()
  await expect(pane).toHaveCount(0)
  await step(second, 'read_open_page')
  await expect(pane).toHaveCount(0)
  await page.locator('.bots-row', { hasText: 'Parallel watch' }).click()
  await expect(pane).toBeVisible()
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}?lane=second`)
  await expect(pane.getByTestId('web-work-status')).toContainText('Comets at work')
  await page.screenshot({ path: join(REPO_TMP, 'web-work-visibility.png') })
  await page.locator('.bots-row', { hasText: 'Watching' }).click()
  await expect(pane).toHaveCount(0)
  await step(first, 'scroll')
  await expect(pane).toHaveCount(0)
  await page.getByTestId('composer-web').click()
  await expect(pane).toBeVisible()
  await expect(page.getByTestId('live-address')).toHaveValue(`${siteUrl}?lane=first`)
  await step(first, 'excel_write')
  await expect(pane.getByTestId('web-work-status')).toHaveAttribute('aria-hidden', 'true')
  await expect(pane).toBeVisible()
})
