import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, type Bot } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

test.describe.configure({ mode: 'serial' })
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const OLD = new Date(Date.now() - 3 * 86_400_000).toISOString()
const RECENT = new Date(Date.now() - 60 * 60_000).toISOString()
let app: ElectronApplication
let page: Page
let target: Bot
let other: Bot

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-conversation-search-'))
  const paths = await initVault(root, { git: false })
  target = await createBot(paths, { name: 'Weekly sync notes' })
  for (const [role, text] of [['user', '회의코드 QX-7731 준비해 주세요'], ['assistant', 'QX-7731 agenda is drafted.'], ['user', 'Add the budget line.'], ['assistant', 'Updated the 견적서 summary.']] as const) await appendBotTurn(paths, target.id, { role, text, at: OLD })
  other = await createBot(paths, { name: 'Quarterly budget review' })
  await appendBotTurn(paths, other.id, { role: 'user', text: 'Check QX-7730 numbers.', at: RECENT })
  await appendBotTurn(paths, other.id, { role: 'assistant', text: 'Numbers checked.', at: RECENT })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: root,
    ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-conversation-search-userdata-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('bots-new')).toBeEnabled()
})

test.afterAll(async () => { await app?.close() })

test('search finds a token from earlier messages of an old, unopened conversation in a collapsed folder', async () => {
  await page.evaluate(async id => {
    const layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Archive' } })
    const folder = layout.chat.folders.find(one => one.name === 'Archive')!.id
    await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder } })
    await window.engram.sidebarChange({ kind: 'chat', change: { action: 'fold-folder', id: folder, collapsed: true } })
  }, target.id)
  const before = await page.evaluate(() => window.engram.sidebarLayout())
  await openActivity(page, 'bots')
  await page.getByTestId('sidebar-create').click()
  await page.getByTestId('bots-new').click(); await page.keyboard.press('Escape')
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  const targetRow = page.getByTestId(`bot-${target.id}`)
  const otherRow = page.getByTestId(`bot-${other.id}`)
  await expect(otherRow).toBeVisible()
  await expect(targetRow).toHaveCount(0)
  const input = page.getByRole('textbox', { name: 'Search conversations', exact: true })
  for (const query of ['QX-7731', 'qx-7731']) {
    await input.fill(query)
    await expect(targetRow).toBeVisible()
    await expect(otherRow).toHaveCount(0)
    await expect(page.locator('.sidebar-conversations .bots-row')).toHaveCount(1)
  }
  await input.fill('Weekly sy')
  await expect(targetRow).toBeVisible()
  await input.fill('견적서')
  await expect(targetRow).toBeVisible()
  await expect(otherRow).toHaveCount(0)
  await input.fill('no such token')
  await expect(page.getByText('No matches found', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await expect(otherRow).toBeVisible()
  await expect(targetRow).toHaveCount(0)
  await expect(page.getByTestId('sidebar-earlier')).toBeVisible()
  expect((await page.evaluate(() => window.engram.sidebarLayout())).chat).toEqual(before.chat)
})
