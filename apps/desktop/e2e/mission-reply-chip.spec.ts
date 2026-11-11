import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeTestApp, openActivity } from './navigation.js'
import { appendBotTurn, createBot, initVault, type Bot } from 'core'
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
let bots: Bot[]

test.beforeEach(async () => {
  await mkdir(TMP, { recursive: true })
  const paths = await initVault(await mkdtemp(join(TMP, 'e2e-mission-chip-vault-')), { git: false })
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
  await page.evaluate((ids) => localStorage.setItem('engram.mission.slots', JSON.stringify([...ids, null])), bots.map((bot) => bot.id))
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  // The reported grid had live web previews in its panes.
  await page.evaluate(({ url, lanes }) => Promise.all(lanes.map((lane) => window.engram.agentGo(url, lane))), { url: `http://127.0.0.1:${address.port}/`, lanes: bots.map((bot) => `bot-${bot.id}`) })
  await expect.poll(async () => (await page.evaluate((lanes) => window.engram.missionFrames(lanes), bots.map((bot) => `bot-${bot.id}`))).every((frame) => Boolean(frame.data)), { timeout: 30_000 }).toBe(true)
  await openActivity(page, 'mission')
  await expectGrid(4)
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
const pane = (index: number) => page.getByTestId(`mini-chat-${bots[index]!.id}`)

async function expectGrid(count: number): Promise<void> {
  await expect(page.getByTestId(`mission-layout-${count}`)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.mission-tile')).toHaveCount(count)
  for (const index of [0, 1, 2].slice(0, count)) await expect(page.getByTestId(`mission-tile-${index}`).locator('.mission-name')).toHaveText(NAMES[index]!)
}

async function clickChip(index: number, layout: number): Promise<void> {
  const chat = pane(index)
  await expect(chat.getByTestId('preview-card')).toBeVisible({ timeout: 20_000 })
  const chip = chat.getByTestId('reply-chip-0')
  await expect(chip).toHaveText(CHIPS[index]![0]!)
  await chip.scrollIntoViewIfNeeded()
  const box = (await chip.boundingBox())!
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="reply-chip-0"]')?.textContent ?? null, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  expect(hit).toBe(CHIPS[index]![0])
  const before = (await sent()).length
  await chip.click()
  await expect.poll(async () => (await sent()).slice(before)).toEqual([{ botId: bots[index]!.id, channel: `bot-${bots[index]!.id}`, message: CHIPS[index]![0] }])
  await expect(chat.locator('.bubble-msg.user').filter({ hasText: CHIPS[index]![0]! })).toHaveCount(1)
  await expectGrid(layout)
  await page.waitForTimeout(500)
  expect((await sent()).length).toBe(before + 1)
  await expect(chat.locator('.bubble-msg.user').filter({ hasText: CHIPS[index]![0]! })).toHaveCount(1)
  await expectGrid(layout)
}

test('a reply chip in the top-left pane with a live preview sends there and keeps the 4-pane grid', async () => {
  await clickChip(0, 4)
  for (const other of [1, 2]) await expect(pane(other).locator('.bubble-msg.user').filter({ hasText: CHIPS[0]![0]! })).toHaveCount(0)
})

test('a reply chip in a non-first pane sends only for that pane', async () => {
  await clickChip(1, 4)
  expect((await sent()).map((one) => one.botId)).toEqual([bots[1]!.id])
  await clickChip(2, 4)
  expect((await sent()).map((one) => one.botId)).toEqual([bots[1]!.id, bots[2]!.id])
})

test('a reply chip in a pane showing its full browser still sends in that pane', async () => {
  // A tile too small for a page keeps only its card, so give the grid room as the live-view fixture does.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(2600, 1600))
  const tile = page.getByTestId('mission-tile-0')
  await expect(tile.getByTestId('preview-card')).toBeVisible({ timeout: 20_000 })
  // The first card action opens the page in the tile; its label follows the thread's language.
  await tile.getByTestId('preview-card').locator('.preview-card-actions button').first().click()
  await expect(tile.locator('.mission-tile-body')).toHaveAttribute('data-web-open', 'true')
  const chip = pane(0).getByTestId('reply-chip-0')
  await chip.scrollIntoViewIfNeeded()
  const box = (await chip.boundingBox())!
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="reply-chip-0"]') !== null, { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe(true)
  await chip.click()
  await expect.poll(sent).toEqual([{ botId: bots[0]!.id, channel: `bot-${bots[0]!.id}`, message: CHIPS[0]![0] }])
  await expect(pane(0).locator('.bubble-msg.user').filter({ hasText: CHIPS[0]![0]! })).toHaveCount(1)
  await expectGrid(4)
})

test('two panes, typed sends, a queued chip and the explicit open button keep their paths', async () => {
  await page.getByTestId('mission-layout-2').click()
  await expectGrid(2)
  await clickChip(1, 2)
  const input = page.getByTestId(`mini-input-${bots[1]!.id}`)
  await input.fill('직접 입력'); await input.press('Enter')
  await expect(pane(1).locator('.bubble-msg.user').filter({ hasText: '직접 입력' })).toHaveCount(1)
  expect((await sent()).map((one) => one.message)).toEqual([CHIPS[1]![0]])
  await app.evaluate(({ BrowserWindow }, channel) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'chat:done', channel, text: 'Done.' }) }, `bot-${bots[1]!.id}`)
  await app.evaluate(() => (globalThis as Fixture).pending.shift()!())
  await expect.poll(async () => (await sent()).map((one) => `${one.botId}:${one.message}`)).toEqual([`${bots[1]!.id}:${CHIPS[1]![0]}`, `${bots[1]!.id}:직접 입력`])
  await expectGrid(2)
  await page.getByTestId('mission-tile-0').locator('.mission-enter').click()
  await expect(page.getByTestId('mission-layout-1')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-testid="bots-view"] .bots-title-pill-name')).toHaveText(NAMES[0]!)
})
