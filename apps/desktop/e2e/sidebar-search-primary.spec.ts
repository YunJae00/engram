import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, type Bot } from 'core'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const AT = new Date(Date.now() - 60 * 60_000).toISOString()
let app: ElectronApplication
let page: Page
let hero: Bot
let plain: Bot

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-sidebar-search-primary-'))
  const paths = await initVault(root, { git: false })
  hero = await createBot(paths, { name: 'Research Buddy' })
  for (const [role, text] of [['user', 'Summarise the history of printing presses.'], ['assistant', 'Here is the summary.'], ['user', 'Thanks.'], ['assistant', 'You are welcome.']] as const) await appendBotTurn(paths, hero.id, { role, text, at: AT })
  plain = await createBot(paths, { name: 'Garden planner' })
  await appendBotTurn(paths, plain.id, { role: 'user', text: 'Plan the tomato beds.', at: AT })
  // createBot writes no version; without version 2 the app's launch reset (core bots-reset.ts) backs the seed up and starts empty.
  const file = join(paths.cache, 'bots.json')
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), version: 2 }, null, 2))
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: root,
    ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-sidebar-search-primary-userdata-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
})

test.afterAll(async () => { await app?.close() })

test('a search that matches only the primary bot does not say No matches found', async () => {
  await openActivity(page, 'bots')
  const heroTile = page.getByTestId(`bot-${hero.id}`)
  const plainRow = page.getByTestId(`bot-${plain.id}`)
  const empty = page.locator('.sidebar-conversations .sidebar-empty')
  await expect(heroTile).toBeVisible()
  await expect(plainRow).toBeVisible()
  expect(await page.evaluate(q => window.engram.botsSearch(q), 'printing')).toEqual([hero.id])
  const input = page.getByRole('textbox', { name: 'Search conversations', exact: true })
  await page.getByTestId('sidebar-search-toggle').click()
  await input.fill('printing')
  await expect(plainRow).toHaveCount(0)
  await expect(heroTile).toBeVisible()
  await page.waitForTimeout(1500)
  await expect(empty).toHaveCount(0)
  await expect(page.getByText('No matches found', { exact: true })).toHaveCount(0)
  await input.fill('Research Bud')
  await expect(heroTile).toBeVisible()
  await expect(empty).toHaveCount(0)
  await input.fill('qqqzzz no such token')
  await expect(page.getByText('No matches found', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await expect(plainRow).toBeVisible()
  await expect(empty).toHaveCount(0)
})
