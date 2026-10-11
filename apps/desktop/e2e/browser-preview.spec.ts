import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createBot, initVault } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

test.describe.configure({ mode: 'serial' })
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication, page: Page, server: Server, url: string, lane: string, shots: string

test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-preview-vault-'))
  const paths = await initVault(vault, { git: false })
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
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.setSize(1100, 825); win.show() })
  await openActivity(page, 'bots')
  await page.locator('.bots-row', { hasText: 'Browser preview' }).click()
})
test.afterAll(async () => { await app?.close(); server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())) })

test('automatic work keeps chat wide and switches between preview, split and full without navigation', async () => {
  await app.evaluate(({ BrowserWindow }, lane) => {
    const send = (event: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', event)
    send({ type: 'comet:working', channel: lane, working: true })
    send({ type: 'comet:step', channel: lane, line: 'read_open_page: Weekly summary' })
  }, lane)
  await page.evaluate(async ({ lane, url }) => window.engram.agentGo(url, lane), { lane, url })
  const preview = page.locator('.browser-preview')
  await expect(preview).toBeVisible()
  await expect(page.getByTestId('native-browser-surface')).toHaveCount(0)
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
  await expect(page.getByTestId('native-browser-surface')).toBeVisible()
  await page.getByRole('button', { name: 'Return to small preview' }).click()
  await preview.getByRole('button', { name: 'Expand browser', exact: true }).click()
  await expect(page.getByTestId('web-pane')).toHaveClass(/expanded/)
  await expect(page.locator('.bots-chat')).toBeHidden()
  await page.getByRole('button', { name: 'Show chat beside browser' }).click()
  await expect(page.locator('.bots-chat')).toBeVisible()
  await expect(page.getByTestId('live-address')).toHaveValue(url)
  await page.getByRole('button', { name: 'Return to small preview' }).click()
  await preview.getByRole('button', { name: 'Minimize preview' }).click()
  await expect(preview).toHaveClass(/minimized/)
  await expect(preview.locator('canvas')).toHaveCount(0)
  await expect(preview.getByRole('button', { name: 'Stop task' })).toBeVisible()
  await preview.getByRole('button', { name: 'Show browser preview' }).click()
  await expect(preview.locator('canvas')).toHaveAttribute('data-painted', '')
  await preview.getByRole('button', { name: 'Expand browser', exact: true }).click()
  await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'press:ask', channel: lane, words: 'Submit report', host: 'example.com' }), lane)
  await expect(page.getByTestId('press-ask')).toBeVisible()
  await expect(preview).toBeVisible()
  await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: false }), lane)
  await expect(preview.getByRole('button', { name: 'Stop task' })).toHaveCount(0)
})

test('preview stays within a narrow window, is draggable and supports dark and reduced-motion modes', async () => {
  const tabs = await page.evaluate(lane => window.engram.browserTabs(lane), lane)
  await page.evaluate(lane => window.engram.browserTab(lane, 'add'), lane)
  const picture = page.locator('.browser-preview canvas')
  await expect(picture).not.toHaveAttribute('data-painted', '')
  await expect(page.locator('.browser-preview-wait')).toHaveText('Open browser to enter a website')
  await page.evaluate(async ({ lane, id }) => window.engram.browserTab(lane, 'select', id), { lane, id: tabs.find(tab => tab.active)!.id })
  await expect(picture).toHaveAttribute('data-painted', '')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.screenshot({ path: join(shots, 'preview-dark.png') })
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.setMinimumSize(600, 600); win.setSize(620, 800) })
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'false') await page.getByTestId('app-sidebar-close').click()
  const preview = page.locator('.browser-preview'), bar = page.locator('.browser-preview-bar')
  const before = (await bar.boundingBox())!
  await page.mouse.move(before.x + 16, before.y + 18)
  await page.mouse.down(); await page.mouse.move(before.x - 800, before.y + 1000); await page.mouse.up()
  const bounds = (await preview.boundingBox())!, main = (await page.locator('.bots-main').boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(main.x)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(main.x + main.width + 1)
  expect(bounds.y + bounds.height).toBeLessThan(main.y + main.height - 60)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(preview).toHaveCSS('animation-name', 'none')
  await page.screenshot({ path: join(shots, 'preview-narrow.png') })
  console.log(`Browser preview screenshots: ${shots}`)
})
