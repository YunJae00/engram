import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, type Bot } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  await expect(page.getByTestId('bots-new')).toBeEnabled()
})

test.afterAll(async () => { await app?.close() })

const search = () => page.getByRole('textbox', { name: 'Search conversations', exact: true })
const rows = () => page.locator('.sidebar-conversations .bots-row')
const empty = () => page.getByText('No matches found', { exact: true })
const row = (bot: Bot | string) => page.getByTestId(`bot-${typeof bot === 'string' ? bot : bot.id}`)
const clear = () => page.getByRole('button', { name: 'Clear search', exact: true }).click()
async function typeQuery(query: string): Promise<void> {
  await page.getByTestId('sidebar-search-toggle').click();
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(query)
}

test('a query found nowhere lists no conversation, even the open one', async () => {
  await row(beta).click()
  await expect(row(beta)).toHaveClass(/active/)
  for (const [query, typed] of [['qqqzzz', true], ['없는단어xyz', true], ['qqqzzz', false]] as const) {
    expect(await page.evaluate(q => window.engram.botsSearch(q), query)).toEqual([])
    if (typed) await typeQuery(query); else { await page.getByTestId('sidebar-search-toggle').click(); await search().fill(query) }
    await expect(search()).toHaveValue(query)
    await expect(rows()).toHaveCount(0)
    await expect(row(beta)).toHaveCount(0)
    await expect(empty()).toBeVisible()
    await clear()
  }
})

test('a query matching only the other chat lists exactly that row', async () => {
  await typeQuery('tulip')
  await expect(row(alpha)).toBeVisible()
  await expect(rows()).toHaveCount(1)
  await expect(row(beta)).toHaveCount(0)
  await expect(empty()).toHaveCount(0)
})

test('clearing the search restores both chats with the open one active', async () => {
  await clear()
  await expect(search()).toHaveValue('')
  await expect(rows()).toHaveCount(2)
  await expect(row(alpha)).toBeVisible()
  await expect(row(beta)).toHaveClass(/active/)
  await expect(row(alpha)).not.toHaveClass(/active/)
})

test('a pinned open chat that does not match is hidden too', async () => {
  await page.getByTestId(`sidebar-chat-menu-${beta.id}`).click()
  await page.locator('.sidebar-organize-menu').getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(row(beta).locator('..')).toHaveAttribute('data-pinned', 'true')
  const before = (await page.evaluate(() => window.engram.sidebarLayout())).chat
  await typeQuery('qqqzzz')
  await expect(rows()).toHaveCount(0)
  await expect(empty()).toBeVisible()
  await clear()
  await expect(rows()).toHaveCount(2)
  await expect(row(beta)).toHaveClass(/active/)
  await expect(row(beta).locator('..')).toHaveAttribute('data-pinned', 'true')
  expect((await page.evaluate(() => window.engram.sidebarLayout())).chat).toEqual(before)
})

test('a chat started during a non-matching search is not listed until the search is cleared', async () => {
  await page.getByTestId('sidebar-create').click()
  await page.getByTestId('bots-new').click(); await page.keyboard.press('Escape')
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  await page.getByTestId('sidebar-search-toggle').click(); await search().fill('qqqzzz')
  await expect(empty()).toBeVisible()
  const input = page.getByTestId('welcome-input')
  await input.fill('Plan the garden layout')
  await input.press('Enter')
  await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(list => list.length))).toBe(3)
  const created = await page.evaluate(ids => window.engram.botsList().then(list => list.find(bot => !ids.includes(bot.id))!.id), [alpha.id, beta.id])
  await expect(rows()).toHaveCount(0)
  await expect(row(created)).toHaveCount(0)
  await expect(empty()).toBeVisible()
  await expect(search()).toHaveValue('qqqzzz')
  await clear()
  await expect(row(created)).toBeVisible()
  await expect(row(created)).toHaveClass(/active/)
  await expect(rows()).toHaveCount(3)
})
