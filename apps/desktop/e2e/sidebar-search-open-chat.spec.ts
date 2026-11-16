import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2, type Bot } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openWelcome } from './navigation.js'

test.describe.configure({ mode: 'serial' })
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const STAMP = new Date(Date.now() - 60 * 60_000).toISOString()
let app: ElectronApplication
let page: Page
let alpha: Bot
let beta: Bot

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-sidebar-search-open-chat-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths) // a v2 list keeps the seeded bots through launch
  alpha = await createBot(paths, { name: 'Alpha garden plan' })
  for (const [role, text] of [['user', 'Order the tulip bulbs.'], ['assistant', 'Tulip order placed.']] as const) await appendBotTurn(paths, alpha.id, { role, text, at: STAMP })
  beta = await createBot(paths, { name: 'Beta budget review' })
  for (const [role, text] of [['user', 'Check the quarterly numbers.'], ['assistant', 'Numbers checked.']] as const) await appendBotTurn(paths, beta.id, { role, text, at: STAMP })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: root,
    ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-sidebar-search-open-chat-userdata-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 840 })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('sidebar-create')).toBeEnabled()
})

test.afterAll(async () => { await app?.close() })

const rows = () => page.locator('.sidebar-conversations .bots-row')
const empty = () => page.getByText('No matches found', { exact: true })
const row = (bot: Bot | string) => page.getByTestId(`bot-${typeof bot === 'string' ? bot : bot.id}`)
const order = () => rows().evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))
const found = (query: string) => page.evaluate(q => window.engram.botsSearch(q).then(hits => hits.map(hit => hit.id)), query)
async function expectNoSearch(): Promise<void> {
  await expect(page.getByTestId('sidebar-search-toggle')).toHaveCount(0)
  await expect(page.getByTestId('app-sidebar').locator('.sidebar-search, input, textarea')).toHaveCount(0)
  await expect(empty()).toHaveCount(0)
}

test('with no search field the open conversation stays listed, and words found nowhere match nothing in the store', async () => {
  await row(beta).click()
  await expect(row(beta)).toHaveClass(/active/)
  await expectNoSearch()
  for (const query of ['qqqzzz', '없는단어xyz']) expect(await found(query)).toEqual([])
  await expect(rows()).toHaveCount(2)
  await expect(row(beta)).toBeVisible()
})

test('words from the other chat find exactly that chat in the store, and it opens with one click', async () => {
  expect(await found('tulip')).toEqual([alpha.id])
  await expectNoSearch()
  await row(alpha).click()
  await expect(row(alpha)).toHaveClass(/active/)
  await expect(row(beta)).not.toHaveClass(/active/)
  await expect(page.getByTestId('bots-thread')).toContainText('Tulip order placed.')
  await expect(rows()).toHaveCount(2)
})

test('both chats stay listed and the one opened last is the only active one', async () => {
  await row(beta).click()
  await expect(rows()).toHaveCount(2)
  await expect(row(alpha)).toBeVisible()
  await expect(row(beta)).toHaveClass(/active/)
  await expect(row(alpha)).not.toHaveClass(/active/)
  await expect(page.getByTestId('bots-thread')).toContainText('Numbers checked.')
})

test('an old pin on the open chat changes neither its place nor its row', async () => {
  const before = await order()
  await row(beta).click({ button: 'right' })
  await expect(page.locator('.sidebar-organize-menu, [role="dialog"][aria-label^="Options for"]')).toHaveCount(0)
  const pinned = (await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'pin-item', id, pinned: true } }), beta.id)).chat
  // The pin is kept as data and drawn nowhere.
  expect((await page.evaluate(() => window.engram.sidebarLayout())).chat).toEqual(pinned)
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'bots:changed' }) })
  await expect(rows()).toHaveCount(2)
  await expect.poll(order).toEqual(before)
  await expect(page.locator('.app-sidebar [data-pinned]')).toHaveCount(0)
  await expect(row(beta)).toHaveClass(/active/)
  await expectNoSearch()
})

test('a chat started from the welcome is listed and active at once', async () => {
  await openWelcome(page)
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  await expectNoSearch()
  // The v2 bot list seeded by the fixture also holds the primary 'Engram' bot (resetBotsToV2), so one new bot is counted against what existed before.
  const existing = await page.evaluate(() => window.engram.botsList().then(list => list.map(bot => bot.id)))
  expect(existing).toEqual(expect.arrayContaining([alpha.id, beta.id]))
  const input = page.getByTestId('welcome-input')
  await input.fill('Plan the garden layout')
  await input.press('Enter')
  await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(list => list.length))).toBe(existing.length + 1)
  const created = await page.evaluate(ids => window.engram.botsList().then(list => list.find(bot => !ids.includes(bot.id))!.id), existing)
  await expect(row(created)).toBeVisible()
  await expect(row(created)).toHaveClass(/active/)
  await expect(rows()).toHaveCount(3)
  await expect(empty()).toHaveCount(0)
})
