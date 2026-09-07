import { test, expect, chromium, _electron as electron, type ElectronApplication, type Browser, type Page } from '@playwright/test'
import { createBot, initVault } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'win32', 'Native browser requires Windows')
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let browser: Browser
let shell: Page
let server: Server
let url: string
let port: number
let ids: string[]
const previousAttach = process.env['PW_CHROMIUM_ATTACH_TO_OTHER']

test.beforeAll(async () => {
  process.env['PW_CHROMIUM_ATTACH_TO_OTHER'] = '1'
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-native-vault-'))
  const userdata = await mkdtemp(join(tmp, 'e2e-native-profile-'))
  const paths = await initVault(vault, { git: false })
  ids = []
  for (let i = 0; i < 4; i++) ids.push((await createBot(paths, { name: `Native ${i + 1}`, purpose: '' })).id)
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><title>Native browser fixture</title><style>body{font:16px sans-serif;margin:24px}input{font:inherit;width:80%;padding:12px}article{height:2600px;background:linear-gradient(#eaf3ff,#345)}</style><h1>Native page</h1><input aria-label="Entry"><button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button><a href="/popup" target="_blank">Popup</a><article>Local browser test</article>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No local test server')
  url = `http://127.0.0.1:${address.port}`
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const debug = probe.address()
  if (!debug || typeof debug === 'string') throw new Error('No test debug port')
  port = debug.port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: userdata, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_BROWSER_EXTERNAL: '0', ENGRAM_AGENT_CDP: String(port) },
  })
  shell = await app.firstWindow()
  await expect(shell.getByTestId('shell')).toBeVisible()
  await expect.poll(() => shell.evaluate(() => window.engram.botsList().then(() => true).catch(() => false)), { timeout: 60000 }).toBe(true)
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]!; win.setSize(1400, 1000); win.show() })
  await shell.evaluate((bots) => localStorage.setItem('engram.mission.slots', JSON.stringify(bots)), ids)
})

test.afterAll(async () => {
  await browser?.close()
  await app?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (previousAttach === undefined) delete process.env['PW_CHROMIUM_ATTACH_TO_OTHER']
  else process.env['PW_CHROMIUM_ATTACH_TO_OTHER'] = previousAttach
})

test('four native pages share the agent connection and keep independent input', async () => {
  expect(await shell.evaluate(() => window.engram.nativeEnabled())).toBe(true)
  await shell.evaluate(async ({ ids, url }) => {
    await Promise.all(ids.map((id, index) => window.engram.agentGo(`${url}/?pane=${index}`, `bot-${id}`)))
  }, { ids, url })
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const context = browser.contexts()[0]!
  await expect.poll(() => context.pages().filter((page) => page.url().startsWith(url)).length).toBe(4)
  await shell.getByTestId('activity-mission').click()
  await expect(shell.locator('.mission-preview').getByTestId('native-browser-surface')).toHaveCount(4)
  for (let i = 0; i < 4; i++) {
    const page = context.pages().find((page) => page.url() === `${url}/?pane=${i}`)!
    await page.getByRole('textbox', { name: 'Entry' }).fill(`Pane ${i} 한글`)
    await page.locator('#count').click()
    await expect(page.locator('#count')).toHaveText('1')
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(700)
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeGreaterThan(100)
  }
  const frames = await shell.evaluate((ids) => window.engram.missionFrames(ids.map((id) => `bot-${id}`)), ids)
  expect(frames.every((frame) => frame.on && !frame.data)).toBe(true)
})

test('resize and chat handoffs retain the live pages and scroll', async () => {
  const pages = browser.contexts()[0]!.pages().filter((page) => page.url().startsWith(url))
  const first = pages.find((page) => page.url() === `${url}/?pane=0`)!
  await first.mouse.wheel(0, 400)
  await expect.poll(() => first.evaluate(() => scrollY)).toBeGreaterThan(100)
  await shell.getByTestId('mission-layout-1').click()
  await expect(shell.locator('.mission-preview').getByTestId('native-browser-surface')).toHaveCount(1)
  await expect.poll(() => first.evaluate(() => innerWidth)).toBeGreaterThan(500)
  await shell.getByTestId('mission-layout-4').click()
  await expect(shell.locator('.mission-preview').getByTestId('native-browser-surface')).toHaveCount(4)
  await shell.getByRole('button', { name: 'Open Native 1', exact: true }).first().click()
  await expect(shell.getByTestId('web-pane')).toBeVisible()
  await expect(shell.getByTestId('live-address')).toHaveValue(`${url}/?pane=0`)
  await shell.getByTestId('activity-mission').click()
  for (let i = 0; i < 4; i++) {
    const page = pages.find((page) => page.url() === `${url}/?pane=${i}`)!
    await expect(page.getByRole('textbox', { name: 'Entry' })).toHaveValue(`Pane ${i} 한글`)
  }
  await expect.poll(() => first.evaluate(() => scrollY)).toBeGreaterThan(100)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 820))
  await expect.poll(() => first.evaluate(() => innerWidth)).toBeLessThan(600)
})

test('popup closure restores the original page', async () => {
  const context = browser.contexts()[0]!
  const first = context.pages().find((page) => page.url() === `${url}/?pane=0`)!
  await first.getByRole('link', { name: 'Popup' }).click()
  await expect.poll(() => context.pages().some((page) => page.url() === `${url}/popup`)).toBe(true)
  const popup = context.pages().find((page) => page.url() === `${url}/popup`)!
  await expect(popup.getByRole('textbox', { name: 'Entry' })).toBeVisible()
  await popup.getByRole('textbox', { name: 'Entry' }).fill('Popup input')
  await expect.poll(async () => (await shell.evaluate((id) => window.engram.missionFrames([`bot-${id}`]), ids[0]!))[0]?.url).toBe(`${url}/popup`)
  await popup.close()
  await expect.poll(async () => (await shell.evaluate((id) => window.engram.missionFrames([`bot-${id}`]), ids[0]!))[0]?.url).toBe(`${url}/?pane=0`)
  await expect(first.getByRole('textbox', { name: 'Entry' })).toHaveValue('Pane 0 한글')
})

test('partially clipped native surfaces retain their full viewport and stay inside the tile border', async () => {
  const surface = shell.locator('.mission-preview').getByTestId('native-browser-surface').first()
  const inset = await surface.evaluate((node) => {
    const box = node.getBoundingClientRect(), parent = node.parentElement!.getBoundingClientRect()
    return { left: box.left - parent.left, bottom: parent.bottom - box.bottom }
  })
  expect(inset.left).toBeGreaterThanOrEqual(9)
  expect(inset.bottom).toBeGreaterThanOrEqual(9)
  const first = browser.contexts()[0]!.pages().find((page) => page.url() === `${url}/?pane=0`)!
  const previous = await surface.getAttribute('style')
  try {
    await surface.evaluate((node) => { node.setAttribute('style', 'position:absolute;left:10px;top:10px;width:240px;height:1200px;flex:none') })
    await expect.poll(() => first.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 240, height: 1200 })
    await first.getByRole('textbox', { name: 'Entry' }).fill('Clipped viewport input')
    await expect(first.getByRole('textbox', { name: 'Entry' })).toHaveValue('Clipped viewport input')
  } finally {
    await surface.evaluate((node, style) => { if (style === null) node.removeAttribute('style'); else node.setAttribute('style', style) }, previous)
    await first.getByRole('textbox', { name: 'Entry' }).fill('Pane 0 한글')
  }
})

test('script popups retain their opener and can close themselves', async () => {
  const context = browser.contexts()[0]!
  const first = context.pages().find((page) => page.url() === `${url}/?pane=0`)!
  await first.evaluate(() => { window.open('/callback', 'callback') })
  await expect.poll(() => context.pages().some((page) => page.url() === `${url}/callback`)).toBe(true)
  const popup = context.pages().find((page) => page.url() === `${url}/callback`)!
  expect(await popup.evaluate(() => Boolean(window.opener))).toBe(true)
  await popup.evaluate(() => { window.opener.document.querySelector('input').value = 'Callback received'; window.close() })
  await expect.poll(() => popup.isClosed()).toBe(true)
  await expect(first.getByRole('textbox', { name: 'Entry' })).toHaveValue('Callback received')
  await expect.poll(async () => (await shell.evaluate((id) => window.engram.missionFrames([`bot-${id}`]), ids[0]!))[0]?.url).toBe(`${url}/?pane=0`)
})

test('folding a tile conversation and dismissing its picker keep the native page interactive', async () => {
  const tile = shell.getByTestId('mission-tile-0')
  const first = browser.contexts()[0]!.pages().find((page) => page.url() === `${url}/?pane=0`)!
  const before = await first.evaluate(() => innerHeight)
  const draft = tile.locator('.mini-chat-write input')
  await draft.fill('Keep the conversation draft')
  await shell.getByTestId('mission-chat-toggle-0').click()
  await expect(tile.locator('.mission-chat-slot')).toBeHidden()
  await expect.poll(() => first.evaluate(() => innerHeight)).toBeGreaterThan(before + 30)
  await shell.getByTestId('mission-chat-toggle-0').click()
  await expect(draft).toHaveValue('Keep the conversation draft')
  await expect.poll(() => first.evaluate(() => innerHeight)).toBeLessThanOrEqual(before + 2)
  await tile.locator('.mission-change').click()
  await expect(shell.getByTestId('mission-add-menu')).toBeVisible()
  await shell.keyboard.press('Escape')
  await expect(tile.locator('.mission-add-menu')).toBeHidden()
  await first.getByRole('textbox', { name: 'Entry' }).fill('Still interactive 한글')
  await expect(first.getByRole('textbox', { name: 'Entry' })).toHaveValue('Still interactive 한글')
  await expect.poll(() => tile.getByTestId('native-browser-surface').evaluate((node) => {
    const box = node.getBoundingClientRect()
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === node
  })).toBe(true)
})
