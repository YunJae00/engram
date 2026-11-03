import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, type VaultPaths } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

test.describe.configure({ mode: 'serial' })
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication, page: Page, server: Server, url: string, lane: string, shots: string, paths: VaultPaths

test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-preview-vault-'))
  paths = await initVault(vault, { git: false })
  lane = `bot-${(await createBot(paths, { name: 'Browser preview' })).id}`
  shots = await mkdtemp(join(tmp, 'browser-preview-shots-'))
  server = createServer((_req, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<html><title>Preview fixture</title><style>body{font:18px sans-serif;margin:24px;background:#f8fafc}h1{color:#30465c}article{margin:16px 0;padding:24px;background:white;border-radius:12px}</style><h1>Weekly work summary</h1><article>Monday · Service development</article><article>Tuesday · Issue review</article><button onclick="this.textContent=\'Clicked\'">Website button</button></html>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  url = `http://127.0.0.1:${address.port}/`
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-preview-profile-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_BROWSER_EXTERNAL: '0',
  } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.setSize(1400, 900); win.show() })
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: 'Browser preview' }).click()
})
test.afterAll(async () => {
  try { await closeTestApp(app) } finally {
    server?.closeAllConnections()
    await new Promise<void>(resolve => server?.close(() => resolve()))
  }
})

test('a manual empty browser offers address entry instead of indefinite loading', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(970, 730))
  await page.getByTestId('bots-input-add').click()
  await page.getByTestId('composer-web').click()
  const expandEmpty = page.getByRole('button', { name: 'Expand preview', exact: true })
  if (await expandEmpty.isVisible()) await expandEmpty.click()
  await expect(page.locator('.preview-card-state')).toHaveText('No website open')
  await page.getByRole('button', { name: 'Open full browser', exact: true }).click()
  await expect(page.getByTestId('live-address')).toBeFocused()
  await expect(page.getByTestId('live-address')).toHaveValue('')
  await page.getByTestId('web-pane-fold').click()
  await expect(page.getByTestId('web-pane')).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900))
})

test('automatic work keeps chat wide and switches between preview, split and full without navigation', async () => {
  await app.evaluate(({ BrowserWindow }, lane) => {
    const send = (event: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', event)
    send({ type: 'comet:working', channel: lane, working: true })
    send({ type: 'comet:step', channel: lane, line: 'read_open_page: Weekly summary' })
  }, lane)
  await page.evaluate(async ({ lane, url }) => window.engram.agentGo(url, lane), { lane, url })
  const preview = page.locator('.preview-card')
  await expect(preview).toBeVisible()
  await expect(page.getByTestId('native-browser-surface')).toHaveCount(0)
  const expandPreview = page.getByTestId('preview-card-collapsed')
  if (await expandPreview.isVisible()) await expandPreview.click()
  await expect(preview.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 60000 })
  await expect.poll(() => preview.locator('canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    let ink = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! < 90 && pixels[i + 1]! < 110 && pixels[i + 2]! < 140) ink++
    return ink
  }), { timeout: 15000 }).toBeGreaterThan(100)
  await expect(page.getByTestId('live-address')).toHaveCount(0)
  const main = await page.locator('.bots-main').boundingBox(), chat = await page.locator('.bots-chat').boundingBox()
  expect(Math.abs(main!.width - chat!.width)).toBeLessThan(2)
  await page.screenshot({ path: join(shots, 'preview-light.png') })
  await preview.getByRole('button', { name: 'Open browser beside chat', exact: true }).click()
  await expect(page.getByTestId('live-address')).toHaveValue(url)
  if (process.platform === 'win32') await expect(page.getByTestId('native-browser-surface')).toBeVisible()
  else await expect(page.getByTestId('web-pane').locator('canvas[data-painted]')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(970, 730))
  await expect(preview).toBeVisible()
  await expect(page.getByTestId('live-address')).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900))
  await expect(page.getByTestId('live-address')).toHaveValue(url)
  await page.getByRole('button', { name: 'Return to small preview' }).click()
  await preview.getByRole('button', { name: /Open (browser beside chat|full browser)/, exact: true }).click()
  if (await page.getByTestId('web-pane-expand').getAttribute('aria-label') === 'Expand browser') await page.getByTestId('web-pane-expand').click()
  await expect(page.getByTestId('web-pane')).toHaveClass(/expanded/)
  await expect(page.locator('.bots-chat')).toBeHidden()
  await page.getByRole('button', { name: 'Show chat beside browser' }).click()
  await expect(page.locator('.bots-chat')).toBeVisible()
  await expect(page.getByTestId('live-address')).toHaveValue(url)
  await page.getByRole('button', { name: 'Return to small preview' }).click()
  await expect(preview.locator('.preview-card-actions button')).toHaveCount(3)
  await preview.getByRole('button', { name: 'Collapse preview', exact: true }).click()
  await expect(preview.locator('canvas')).toHaveCount(0)
  await page.getByTestId('preview-card-collapsed').click()
  await expect(preview.locator('canvas[data-painted]')).toBeVisible()
  await expect(preview.getByText('Open browser', { exact: true })).toHaveCount(0)
  await page.getByTestId('bots-input-add').click()
  await page.getByTestId('composer-web').click()
  await expect(preview).toHaveCount(0)
  await page.getByTestId('bots-input-add').click()
  await page.getByTestId('composer-web').click()
  await page.getByRole('button', { name: 'Return to small preview' }).click()
  await expect(preview.locator('canvas')).toHaveAttribute('data-painted', '')
  await preview.getByRole('button', { name: 'Open browser beside chat', exact: true }).click()
  if (await page.getByTestId('web-pane-expand').isVisible()) await page.getByTestId('web-pane-expand').click()
  await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'press:ask', channel: lane, words: 'Submit report', host: 'example.com' }), lane)
  await expect(page.getByTestId('press-ask')).toBeVisible()
  await expect(page.getByTestId('preview-card-collapsed')).toBeVisible()
  await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: false }), lane)
  await expect(page.getByTestId('preview-card-collapsed')).toBeVisible()
})

test('small windows open from the composer as a preview and expand only on request', async () => {
  await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: true }), lane)
  await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: false }), lane)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(970, 730))
  await page.getByTestId('bots-input-add').click()
  await page.getByTestId('composer-web').click()
  await expect(page.getByTestId('web-pane')).toHaveCount(0)
  await page.getByTestId('bots-input-add').click()
  await page.getByTestId('composer-web').click()
  const preview = page.locator('.preview-card')
  const collapsed = page.getByTestId('preview-card-collapsed')
  if (await collapsed.isVisible()) await collapsed.click()
  await expect(preview).toBeVisible()
  await expect(preview).toHaveCSS('animation-name', 'preview-card-in')
  await expect(page.getByTestId('live-address')).toHaveCount(0)
  const main = await page.locator('.bots-main').boundingBox(), chat = await page.locator('.bots-chat').boundingBox()
  expect(Math.abs(main!.width - chat!.width)).toBeLessThan(2)
  await preview.getByRole('button', { name: /Open (browser beside chat|full browser)/, exact: true }).click()
  if (await page.getByTestId('web-pane-expand').getAttribute('aria-label') === 'Expand browser') await page.getByTestId('web-pane-expand').click()
  await expect(page.getByTestId('web-pane')).toHaveClass(/expanded/)
  await expect(page.getByTestId('live-address')).toHaveValue(url)
  await page.getByRole('button', { name: 'Return to small preview' }).click()
  await expect(preview).toBeVisible()
  const expandPreview = page.getByTestId('preview-card-collapsed')
  if (await expandPreview.isVisible()) await expandPreview.click()
  await expect(preview.locator('canvas')).toHaveAttribute('data-painted', '', { timeout: 60000 })
  await expect(preview).toHaveCSS('opacity', '1')
  await page.screenshot({ path: join(shots, 'preview-compact.png') })
})

test('preview stays within a narrow window, stays above the thread and supports dark and reduced-motion modes', async () => {
  const tabs = await page.evaluate(lane => window.engram.browserTabs(lane), lane)
  await page.evaluate(lane => window.engram.browserTab(lane, 'add'), lane)
  const picture = page.locator('.preview-card canvas')
  await expect(picture).toHaveCount(0)
  await expect(page.locator('.preview-card-state')).toHaveText('No website open')
  await page.evaluate(async ({ lane, id }) => window.engram.browserTab(lane, 'select', id), { lane, id: tabs.find(tab => tab.active)!.id })
  await expect(picture).toHaveAttribute('data-painted', '')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.screenshot({ path: join(shots, 'preview-dark.png') })
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.setMinimumSize(600, 600); win.setSize(620, 800) })
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
  await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'press:ask', channel: lane, words: 'Submit report', host: 'example.com' }), lane)
  const preview = page.getByTestId('preview-card-collapsed')
  await expect(page.getByTestId('preview-card-collapsed')).toBeVisible()
  await page.getByTestId('press-ask').getByRole('button', { name: 'Go ahead', exact: true }).click({ trial: true })
  await expect(page.locator('.preview-card-bar')).toHaveCount(0)
  const bounds = (await preview.boundingBox())!, main = (await page.locator('.bots-chat').boundingBox())!
  const thread = (await page.getByTestId('bots-thread').boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(main.x)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(main.x + main.width + 1)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(thread.y + 1)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(preview).toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: join(shots, 'preview-narrow.png') })
  console.log(`Browser preview screenshots: ${shots}`)
})


test('finished work keeps its preview expanded with the last screen', async () => {
  await app.evaluate(({ BrowserWindow }, lane) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents
    contents.send('engram:event', { type: 'comet:working', channel: lane, working: true })
    contents.send('engram:event', { type: 'comet:step', channel: lane, line: 'read_open_page: Final page' })
  }, lane)
  await expect(page.locator('.preview-card')).toBeVisible()
  await appendBotTurn(paths, lane.slice(4), { role: 'assistant', text: 'The result is ready to read.', at: new Date().toISOString() })
  await app.evaluate(({ BrowserWindow }, lane) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setSize(1400, 900)
    win.webContents.send('engram:event', { type: 'chat:done', channel: lane, text: 'The result is ready to read.' })
    win.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: false })
  }, lane)
  await expect(page.getByTestId('bots-thread')).toContainText('The result is ready to read.')
  await expect(page.getByTestId('preview-card')).toBeVisible()
  await expect(page.getByTestId('preview-card')).toContainText('Last snapshot')
  await page.screenshot({ path: join(shots, 'preview-finished.png') })
  await expect(page.locator('.preview-card canvas')).toHaveAttribute('data-painted', '')
})


test('status notices leave full and split conversation composers unobscured', async () => {
  expect(await page.evaluate(() => CSS.supports('top', 'calc(anchor(--status-banner bottom, 44px) + 8px)'))).toBe(true)
  await page.addStyleTag({ content: '.connect-banner { min-height: 80px }' })
  for (const layout of [1, 2]) {
    if (await page.locator('.sidebar-scrim').isVisible()) await page.locator('.sidebar-scrim').click()
    await page.getByTestId(`mission-layout-${layout}`).click()
    for (const width of [1280, 620]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]!.setSize(width, 850), width)
      if (await page.locator('.sidebar-scrim').isVisible()) await page.locator('.sidebar-scrim').click()
      console.info('NOTICE_VIEWPORT', { layout, requestedWidth: width, ...await page.evaluate(() => ({ actualWidth: innerWidth, actualHeight: innerHeight })) })
      await expect(page.locator('.toast')).toHaveCount(0)
      await app.evaluate(({ BrowserWindow }, context) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', {
        type: 'task:notice', message: `The current task is paused. Your work has been kept; continue when ready. (${context})`,
      }), `${layout}/${width}`)
      await expect(page.locator('.toast')).toBeVisible()
      const composer = page.locator(layout === 1 ? '.bots-write' : '.mini-chat-write').first()
      await expect(composer).toBeVisible()
      await expect.poll(async () => {
        const notice = (await page.locator('.toast').boundingBox())!
        const input = (await composer.boundingBox())!
        return notice.y + notice.height <= input.y || notice.x + notice.width <= input.x || notice.x >= input.x + input.width
      }).toBe(true)
      for (const banner of await page.locator('.connect-banner').all()) {
        const box = (await banner.boundingBox())!
        expect((await page.locator('.toast').boundingBox())!.y).toBeGreaterThanOrEqual(box.y + box.height)
      }
      await page.screenshot({ path: join(shots, `notice-${layout}-${width}.png`) })
    }
  }
})
