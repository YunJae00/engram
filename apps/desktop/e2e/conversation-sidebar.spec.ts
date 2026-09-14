import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, type Bot, type VaultPaths } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

test.describe.configure({ mode: 'serial' })
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const FIRST_TITLE = 'Cobalt deployment decisions for the next three release cycles'
const STAMP = '2026-09-10T08:35:00.000Z'
let app: ElectronApplication
let page: Page
let paths: VaultPaths
let screenshots: string
const bots: Bot[] = []

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-conversation-sidebar-'))
  paths = await initVault(root, { git: false })
  screenshots = await mkdtemp(join(TMP, 'conversation-sidebar-shots-'))
  for (let index = 0; index < 28; index++) {
    const bot = await createBot(paths, { name: index === 0 ? FIRST_TITLE : `Project ${String(index).padStart(2, '0')} planning and delivery conversation` })
    bots.push(bot)
    await appendBotTurn(paths, bot.id, { role: 'user', text: 'Review the project details.', at: STAMP })
    await appendBotTurn(paths, bot.id, {
      role: index === 1 ? 'user' : 'assistant',
      text: index === 0 ? '**Tomorrow’s checkpoint is ready.**' : index === 1 ? 'Please verify the handoff checklist.' : `The project ${index} review is complete.`,
      at: STAMP,
    })
  }
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: root,
    ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-conversation-sidebar-userdata-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('bots-new')).toBeEnabled()
})

test.afterAll(async () => { await app?.close() })

async function showSidebar(): Promise<void> {
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await expect(page.getByTestId('app-sidebar')).toBeVisible()
}

async function capture(name: string): Promise<void> {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(screenshots, name), Buffer.from(png, 'base64'))
}

test('folder deletion offers cancellation and includes conversations hidden by search', async () => {
  await openActivity(page, 'bots')
  const ids = await page.evaluate(async () => {
    const first = await window.engram.botCreate({ name: 'Visible deletion fixture' })
    const second = await window.engram.botCreate({ name: 'Hidden deletion fixture' })
    const layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Deletion fixture' } })
    const folder = layout.chat.folders.find(item => item.name === 'Deletion fixture')!
    for (const id of [first.id, second.id]) await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder: folder.id } })
    return [first.id, second.id]
  })
  await page.getByRole('textbox', { name: 'Search conversations', exact: true }).fill('Visible deletion')
  await page.getByRole('button', { name: 'Options for Deletion fixture', exact: true }).click()
  await page.getByRole('dialog', { name: 'Options for Deletion fixture', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete folder?', exact: true })
  await expect(dialog).toContainText('2 conversations')
  expect(await dialog.evaluate(node => { const rect = node.getBoundingClientRect(); return Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 2 && Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 2 })).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await capture('delete-folder-confirmation.png')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.evaluate(async ids => (await window.engram.botsList()).filter(bot => ids.includes(bot.id)).length, ids)).toBe(2)
  await page.getByRole('button', { name: 'Options for Deletion fixture', exact: true }).click()
  await page.getByRole('dialog', { name: 'Options for Deletion fixture', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete folder and 2 conversations', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(async ids => (await window.engram.botsList()).some(bot => ids.includes(bot.id)), ids)).toBe(false)
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
})

test('conversation rows show persisted previews, timestamps and avatars after reload', async () => {
  const first = page.getByTestId(`bot-${bots[0]!.id}`)
  await expect(first.locator('.sidebar-conversation-name')).toHaveText(bots[0]!.name)
  await expect(first.locator('.sidebar-conversation-preview')).toHaveText('Tomorrow’s checkpoint is ready.')
  await expect(first.locator('time')).toHaveAttribute('datetime', STAMP)
  await expect(first.locator('time')).not.toHaveText('')
  await expect(first.locator('.comet-avatar svg')).toBeVisible()
  await expect(page.getByTestId(`bot-${bots[1]!.id}`).locator('.sidebar-conversation-preview')).toHaveText('You: Please verify the handoff checklist.')
  const saved = await page.evaluate(id => window.engram.botsList().then(list => list.find(bot => bot.id === id)), bots[0]!.id)
  expect(saved?.lastMessage).toMatchObject({ role: 'assistant', text: '**Tomorrow’s checkpoint is ready.**', at: STAMP })
  await first.click()
  await expect(page.getByTestId('bots-thread')).toContainText('Tomorrow’s checkpoint is ready.')
  await page.reload()
  await expect(first.locator('.sidebar-conversation-preview')).toHaveText('Tomorrow’s checkpoint is ready.')
  await expect(first.locator('time')).toHaveAttribute('datetime', STAMP)
})

test('Engram navigation is inside its menu and the menu stays within the window', async () => {
  await showSidebar()
  for (const activity of ['bots', 'sky', 'list', 'mission']) await expect(page.getByTestId(`activity-${activity}`)).toHaveCount(0)
  await expect(page.getByTestId('app-sidebar').locator('.sidebar-nav-row')).toHaveCount(0)
  await page.getByTestId('workspace-switcher').click()
  const menu = page.getByTestId('workspace-menu')
  await expect(menu).toBeVisible()
  for (const activity of ['bots', 'sky', 'list', 'routines']) await expect(menu.getByTestId(`activity-${activity}`)).toBeVisible()
  await expect(menu.getByTestId('activity-mission')).toHaveCount(0)
  expect(await menu.evaluate(node => {
    const box = node.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
  })).toBe(true)
  await menu.getByTestId('activity-sky').click()
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await expect(menu).toHaveCount(0)
  await openActivity(page, 'bots')
})

test('New comet stays visible while long conversations scroll', async () => {
  await showSidebar()
  const button = page.getByTestId('bots-new')
  await expect(button).toHaveText('New comet')
  const before = await button.boundingBox()
  const scroll = page.locator('.sidebar-scroll')
  expect(await scroll.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight })
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  await expect(button).toBeInViewport()
  const after = await button.boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
  await button.click()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  expect(await page.evaluate(() => window.engram.botsList().then(list => list.length))).toBe(bots.length)
})

test('search finds long titles and previews inside collapsed folders without changing organization', async () => {
  const folderIds = await page.evaluate(async ({ first, other }) => {
    let layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Release decisions' } })
    const matching = layout.chat.folders.find(folder => folder.name === 'Release decisions')!.id
    await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id: first, folder: matching } })
    await window.engram.sidebarChange({ kind: 'chat', change: { action: 'fold-folder', id: matching, collapsed: true } })
    layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Unrelated work' } })
    const unrelated = layout.chat.folders.find(folder => folder.name === 'Unrelated work')!.id
    await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id: other, folder: unrelated } })
    return { matching, unrelated }
  }, { first: bots[0]!.id, other: bots[2]!.id })
  const before = await page.evaluate(() => window.engram.sidebarLayout())
  await expect(page.getByTestId(`sidebar-folder-${folderIds.matching}`).getByRole('button', { name: /Release decisions/ }).first()).toHaveAttribute('aria-expanded', 'false')
  const input = page.getByRole('textbox', { name: 'Search conversations', exact: true })
  await input.fill('COBALT')
  const first = page.getByTestId(`bot-${bots[0]!.id}`)
  await expect(first).toBeVisible()
  await expect(page.locator('.sidebar-conversations .bots-row')).toHaveCount(1)
  await expect(page.getByTestId(`sidebar-folder-${folderIds.unrelated}`)).toHaveCount(0)
  expect(await first.locator('.sidebar-conversation-name').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
  await input.fill('handoff checklist')
  await expect(page.getByTestId(`bot-${bots[1]!.id}`)).toBeVisible()
  await expect(page.locator('.sidebar-conversations .bots-row')).toHaveCount(1)
  await input.fill('no matching conversation')
  await expect(page.getByText('No matches found', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search', exact: true }).click()
  await expect(first).not.toBeVisible()
  expect((await page.evaluate(() => window.engram.sidebarLayout())).chat).toEqual(before.chat)
})

test('sidebar fits light, dark and narrow layouts with captured examples', async () => {
  await showSidebar()
  await page.locator('.sidebar-scroll').evaluate(node => { node.scrollTop = 0 })
  for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 620], ['dark', 620]] as const) {
    await page.setViewportSize({ width, height: 840 })
    await page.evaluate(async value => window.engram.settingsSet({ ...await window.engram.settingsGet(), theme: value }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await showSidebar()
    await expect(page.getByTestId('bots-new')).toBeInViewport()
    expect(await page.getByTestId('app-sidebar').evaluate(node => {
      const box = node.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight + 1 && node.scrollWidth <= node.clientWidth
    })).toBe(true)
    await capture(`sidebar-${theme}-${width}.png`)
  }
  await page.setViewportSize({ width: 1280, height: 840 })
})

test('conversation menus replace dates on interaction and pin without losing folders', async () => {
  await showSidebar()
  await expect(page.getByTestId('sidebar-chats-toggle')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-routine-collection')).toHaveCount(0)
  await expect(page.getByText('Drop here', { exact: true })).toHaveCount(0)
  const id = bots[1]!.id
  const row = page.getByTestId(`bot-${id}`)
  await row.scrollIntoViewIfNeeded()
  const options = page.getByTestId(`sidebar-chat-menu-${id}`)
  await options.click()
  const menu = page.locator('.sidebar-organize-menu')
  await expect(menu.getByRole('button')).toHaveCount(3)
  for (const label of ['Rename', 'Pin', 'Delete']) await expect(menu.getByRole('button', { name: label, exact: true }).locator('svg')).toBeVisible()
  const optionsBox = await options.boundingBox()
  const rowBox = await row.boundingBox()
  await expect(row.locator('time')).toHaveCSS('opacity', '0')
  expect(optionsBox!.x + optionsBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width)
  const preview = await row.locator('.sidebar-conversation-preview').boundingBox()
  expect(rowBox!.x + rowBox!.width - preview!.x - preview!.width).toBeLessThan(16)
  await menu.getByRole('button', { name: 'Pin', exact: true }).click()
  await expect(page.getByTestId('sidebar-chats').locator('.bots-row').first()).toHaveAttribute('data-testid', `bot-${id}`)
  await expect(row.locator('..').getByLabel('Pinned conversation')).toBeVisible()
  const before = (await page.evaluate(() => window.engram.sidebarLayout())).chat
  await page.reload()
  await expect(page.getByTestId('bots-new')).toBeEnabled()
  await expect(row.locator('..').getByLabel('Pinned conversation')).toBeVisible()
  expect((await page.evaluate(() => window.engram.sidebarLayout())).chat).toEqual(before)
  await options.click()
  await menu.getByRole('button', { name: 'Unpin', exact: true }).click()
  await expect(row.locator('..').getByLabel('Pinned conversation')).toHaveCount(0)
  await capture('conversation-folders-and-menus.png')
})

test('welcome Web opens a new selected chat and transfers its draft without sending', async () => {
  await showSidebar()
  await page.getByTestId('bots-new').click()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  const draft = 'Check the release checklist on the project website.'
  await page.getByTestId('welcome-input').fill(draft)
  const before = await page.evaluate(() => window.engram.botsList())
  await page.getByTestId('welcome-web').click()
  await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
  await expect(page.getByTestId('bots-input')).toHaveValue(draft)
  await expect(page.getByTestId('web-pane')).toBeVisible()
  const after = await page.evaluate(() => window.engram.botsList())
  expect(after).toHaveLength(before.length + 1)
  const created = after.find(bot => !before.some(old => old.id === bot.id))!
  await expect(page.getByTestId(`bot-${created.id}`)).toHaveClass(/active/)
  expect(await page.evaluate(id => localStorage.getItem('engram.comets.selected') === id, created.id)).toBe(true)
  expect(await page.evaluate(id => window.engram.botTranscript(id), created.id)).toEqual([])
  expect(await page.evaluate(() => window.engram.chatActive())).toEqual([])
  await page.getByTestId('web-pane-fold').click()
  await expect(page.getByTestId('web-pane')).toHaveCount(0)
  await expect(page.getByTestId('bots-input')).toHaveValue(draft)
  await capture('welcome-web-chat.png')
})

test('split controls keep the current conversation and add independent chats', async () => {
  const current = await page.evaluate(() => localStorage.getItem('engram.comets.selected'))
  expect(current).toBeTruthy()
  await page.getByTestId('mission-layout-2').click()
  await expect(page.getByTestId('mission-control')).toBeVisible()
  await expect(page.getByTestId('mission-tile-0').getByTestId(`mini-chat-${current}`)).toBeVisible()
  await expect(page.locator('.mission-tile')).toHaveCount(2)
  await page.getByTestId('mission-add-1').click()
  await page.getByTestId('mission-add-menu').getByRole('button', { name: bots[1]!.name, exact: true }).click()
  const first = page.getByTestId(`mini-chat-${current}`).getByRole('textbox')
  const second = page.getByTestId(`mini-chat-${bots[1]!.id}`).getByRole('textbox')
  await first.fill('')
  await first.pressSequentially('First conversation draft')
  await expect(first).toHaveValue('First conversation draft')
  await second.fill('Second conversation draft')
  await expect(page.getByTestId('mission-tile-1').locator('.mission-tile-body')).toHaveAttribute('data-web-open', 'false')
  expect(await page.getByTestId('mission-tile-1').evaluate(node => node.querySelector('.mini-chat')!.getBoundingClientRect().width / node.getBoundingClientRect().width)).toBeGreaterThan(0.95)
  await page.getByTestId('mission-layout-1').click()
  await expect(page.getByTestId('mission-control')).toHaveCount(0)
  await expect(page.getByTestId('bots-input')).toHaveValue('First conversation draft')
  await page.getByTestId('mission-layout-4').click()
  await expect(page.locator('.mission-tile')).toHaveCount(4)
  await expect(first).toHaveValue('First conversation draft')
  await expect(second).toHaveValue('Second conversation draft')
  await capture('split-conversations.png')
})
