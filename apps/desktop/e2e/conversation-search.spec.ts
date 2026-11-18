import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2, type Bot } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity, openWelcome } from './navigation.js'

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
  await resetBotsToV2(paths)
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
  await expect(page.getByTestId('sidebar-create')).toBeEnabled()
})

test.afterAll(async () => { await app?.close() })

test('an old, unopened conversation in a collapsed folder opens from its folder without search, and its earlier words are still findable in the store', async () => {
  await page.evaluate(async id => {
    const layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Archive' } })
    const folder = layout.chat.folders.find(one => one.name === 'Archive')!.id
    await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder } })
    await window.engram.sidebarChange({ kind: 'chat', change: { action: 'fold-folder', id: folder, collapsed: true } })
  }, target.id)
  const before = await page.evaluate(() => window.engram.sidebarLayout())
  await openActivity(page, 'bots')
  await openWelcome(page)
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  const targetRow = page.getByTestId(`bot-${target.id}`)
  const otherRow = page.getByTestId(`bot-${other.id}`)
  await expect(otherRow).toBeVisible()
  const looseX = (await otherRow.boundingBox())!.x
  await expect(targetRow).toBeHidden()
  const head = page.getByTestId(`sidebar-folder-${before.chat.folders.find(one => one.name === 'Archive')!.id}`).locator('.sidebar-folder-head .sidebar-item-main')
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('sidebar-search-toggle')).toHaveCount(0)
  await expect(page.getByTestId('app-sidebar').locator('.sidebar-search, input, textarea')).toHaveCount(0)
  for (const query of ['QX-7731', 'qx-7731', '견적서']) {
    const hits = await page.evaluate(q => window.engram.botsSearch(q), query)
    expect(hits.map(hit => hit.id)).toEqual([target.id])
    if (query !== '견적서') expect(hits[0]!.excerpt).toContain('QX-7731')
  }
  expect(await page.evaluate(q => window.engram.botsSearch(q), 'no such token')).toEqual([])
  await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  await expect(targetRow).toBeVisible()
  expect((await targetRow.boundingBox())!.x).toBeGreaterThanOrEqual(looseX + 10)
  await targetRow.click()
  await expect(targetRow).toHaveClass(/active/)
  await expect(page.getByTestId('bots-thread')).toContainText('QX-7731 agenda is drafted.')
  await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await expect(otherRow).toBeVisible()
  await expect(targetRow).toBeHidden()
  await expect(page.getByTestId('sidebar-earlier')).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(() => window.engram.sidebarLayout())).chat).toEqual(before.chat)
})
