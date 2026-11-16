import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeTestApp } from './navigation.js'
import { appendBotTurn, createBot, initVault, resetBotsToV2, type Bot } from 'core'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const NAMES = ['Halley', 'Encke', 'Tempel']
const CHIPS = [['다음 근접 시기 알려줘', '근일점·원일점 거리도 알려줘'], ['엔케 주기 알려줘', '발견자 알려줘'], ['템펠 궤도 알려줘', '충돌 실험 알려줘']]
type Fixture = typeof globalThis & { sent: { botId: string; channel: string; message: string }[]; pending: (() => void)[] }

let app: ElectronApplication
let page: Page
let server: Server
let siteUrl: string
let bots: Bot[]

test.beforeEach(async () => {
  await mkdir(TMP, { recursive: true })
  const paths = await initVault(await mkdtemp(join(TMP, 'e2e-mission-chip-vault-')), { git: false })
  await resetBotsToV2(paths) // a v2 list keeps the seeded bots through launch
  const at = new Date().toISOString()
  bots = []
  for (const [index, name] of NAMES.entries()) {
    const bot = await createBot(paths, { name, purpose: '' })
    bots.push(bot)
    await appendBotTurn(paths, bot.id, { role: 'user', text: `${name} 혜성 찾아줘`, at })
    await appendBotTurn(paths, bot.id, { role: 'assistant', text: `${name} 혜성은 단주기 혜성입니다.\n\n\`\`\`replies\n${CHIPS[index]!.join('\n')}\n\`\`\``, at })
  }
  server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<html><head><title>Page ${req.url}</title></head><body><h1>Comet</h1></body></html>`) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('the local site did not start')
  siteUrl = `http://127.0.0.1:${address.port}/`
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const probeAddress = probe.address()
  if (!probeAddress || typeof probeAddress === 'string') throw new Error('no browser test port')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-mission-chip-userdata-')),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
      ENGRAM_AGENT_CDP: String(probeAddress.port), ENGRAM_BROWSER_EXTERNAL: '1',
    },
  })
  page = await app.firstWindow({ timeout: 60_000 })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1400, 900))
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  await app.evaluate(({ ipcMain }) => {
    const fixture = globalThis as Fixture
    fixture.sent = []; fixture.pending = []
    for (const channel of ['chat:send', 'chat:active']) ipcMain.removeHandler(channel)
    ipcMain.handle('chat:active', () => [])
    ipcMain.handle('chat:send', (_event, request: { channel: string; message: string }) => new Promise<void>((resolve) => {
      fixture.sent.push({ botId: request.channel.replace(/^bot-/, ''), channel: request.channel, message: request.message })
      fixture.pending.push(resolve)
    }))
  })
  await expectSingleView()
})

test.afterEach(async () => {
  try {
    await app?.evaluate(() => { for (const resolve of (globalThis as Fixture).pending ?? []) resolve() }).catch(() => undefined)
    await closeTestApp(app)
  } finally {
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  }
})

const sent = () => app.evaluate(() => (globalThis as Fixture).sent)
const thread = () => page.getByTestId('bots-thread')

// One chat view: no pane grid, and a suggested reply is never a button.
async function expectSingleView(): Promise<void> {
  for (const count of [1, 2, 4]) await expect(page.getByTestId(`mission-layout-${count}`)).toHaveCount(0)
  await expect(page.locator('.mission-tile')).toHaveCount(0)
  await expect(page.getByTestId('reply-chips')).toHaveCount(0)
  await expect(page.getByTestId('reply-chip-0')).toHaveCount(0)
}

// Opens the bot with its sidebar row and gives it a live web preview, as the reported chats had.
async function openChat(index: number): Promise<void> {
  const row = page.getByTestId(`bot-${bots[index]!.id}`)
  await row.click()
  await expect(row).toHaveClass(/active/)
  await expect(thread().locator('.bubble-msg.assistant').filter({ hasText: `${NAMES[index]!} 혜성은 단주기 혜성입니다.` })).toBeVisible()
  const lane = `bot-${bots[index]!.id}`
  await app.evaluate(({ BrowserWindow }, channel) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:step', channel, line: 'read_open_page: Comet' }), lane)
  await page.evaluate(({ url, lane }) => window.engram.agentGo(url, lane), { url: siteUrl, lane })
  await expect(page.getByTestId('preview-card')).toBeVisible({ timeout: 20_000 })
}

// The reply the answer suggested is typed by the person: it sends once, for the open bot only.
async function typeReply(index: number): Promise<void> {
  await expectSingleView()
  const before = (await sent()).length
  const input = page.getByTestId('bots-input')
  await input.fill(CHIPS[index]![0]!); await input.press('Enter')
  await expect.poll(async () => (await sent()).slice(before)).toEqual([{ botId: bots[index]!.id, channel: `bot-${bots[index]!.id}`, message: CHIPS[index]![0] }])
  await expect(thread().locator('.bubble-msg.user').filter({ hasText: CHIPS[index]![0]! })).toHaveCount(1)
  await page.waitForTimeout(500)
  expect((await sent()).length).toBe(before + 1)
  await expect(thread().locator('.bubble-msg.user').filter({ hasText: CHIPS[index]![0]! })).toHaveCount(1)
  await expectSingleView()
}

test('a suggested reply typed in a chat with a live preview sends there; no reply chip or pane grid exists', async () => {
  await openChat(0)
  await typeReply(0)
  for (const other of [1, 2]) {
    await page.getByTestId(`bot-${bots[other]!.id}`).click()
    await expect(thread().locator('.bubble-msg.assistant').filter({ hasText: `${NAMES[other]!} 혜성은 단주기 혜성입니다.` })).toBeVisible()
    await expect(thread().locator('.bubble-msg.user').filter({ hasText: CHIPS[0]![0]! })).toHaveCount(0)
  }
})

test('a typed reply in another bot\'s chat sends only for that bot', async () => {
  await openChat(1)
  await typeReply(1)
  expect((await sent()).map((one) => one.botId)).toEqual([bots[1]!.id])
  await openChat(2)
  await typeReply(2)
  expect((await sent()).map((one) => one.botId)).toEqual([bots[1]!.id, bots[2]!.id])
})

test('a typed reply beside the open page pane still sends for that bot', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(2600, 1600))
  await openChat(0)
  // The first card action opens the page beside the chat; its label follows the thread's language.
  await page.getByTestId('preview-card').locator('.preview-card-actions button').first().click()
  await expect(page.getByTestId('web-pane')).toBeVisible()
  await expect(page.getByTestId('live-address')).toHaveValue(siteUrl)
  await typeReply(0)
  await expect(page.getByTestId('web-pane')).toBeVisible()
})

test('typed sends and a message typed while the bot works keep their order, and a sidebar row opens the chosen chat', async () => {
  await openChat(1)
  await typeReply(1)
  const input = page.getByTestId('bots-input')
  await input.fill('직접 입력'); await input.press('Enter')
  await expect(thread().locator('.bubble-msg.user').filter({ hasText: '직접 입력' })).toHaveCount(1)
  expect((await sent()).map((one) => one.message)).toEqual([CHIPS[1]![0]])
  await app.evaluate(({ BrowserWindow }, channel) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'chat:done', channel, text: 'Done.' }) }, `bot-${bots[1]!.id}`)
  await app.evaluate(() => (globalThis as Fixture).pending.shift()!())
  await expect.poll(async () => (await sent()).map((one) => `${one.botId}:${one.message}`)).toEqual([`${bots[1]!.id}:${CHIPS[1]![0]}`, `${bots[1]!.id}:직접 입력`])
  await expectSingleView()
  const first = page.getByTestId(`bot-${bots[0]!.id}`)
  await first.click()
  await expect(first).toHaveClass(/active/)
  await expect(thread().locator('.bubble-msg.assistant').filter({ hasText: `${NAMES[0]!} 혜성은 단주기 혜성입니다.` })).toBeVisible()
  await expect(thread().locator('.bubble-msg.user').filter({ hasText: '직접 입력' })).toHaveCount(0)
})
