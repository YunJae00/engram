import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2, type Bot, type VaultPaths } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBotFromPlus, openActivity, openWelcome } from './navigation.js'

test.describe.configure({ mode: 'serial' })
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const FIRST_TITLE = 'Cobalt deployment decisions for the next three release cycles'
// Recent, so every seeded conversation is in the list rather than under Show earlier.
const STAMP = new Date(Date.now() - 60 * 60_000).toISOString()
let app: ElectronApplication
let page: Page
let paths: VaultPaths
let screenshots: string, root: string
const bots: Bot[] = []

async function launch(): Promise<void> {
  const userData = await mkdtemp(join(TMP, 'e2e-conversation-sidebar-userdata-'))
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 840 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible(); await expect(page.getByTestId('sidebar-create')).toBeEnabled()
}

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  root = await mkdtemp(join(TMP, 'e2e-conversation-sidebar-'))
  paths = await initVault(root, { git: false }); await resetBotsToV2(paths) // v2 list with its own primary, so launch keeps the seeded bots and bots[0] is a row
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
  const weekly = await createBot(paths, { name: '주간회의' })
  bots.push(weekly)
  for (const [role, text] of [['user', '법무팀 검토 일정 잡아 주세요'], ['assistant', '11/16 오전으로 잡았습니다.'], ['user', 'Thanks.'], ['assistant', 'Done.']] as const) await appendBotTurn(paths, weekly.id, { role, text, at: STAMP })
  await launch()
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

// The sidebar lists and opens; it has no search field, no menus and no drag. Organizing is asked for in chat.
const menus = () => page.locator('.sidebar-organize-menu, .sidebar-menu, [role="dialog"][aria-label^="Options for"]')
const chatLayout = async () => (await page.evaluate(() => window.engram.sidebarLayout())).chat
const found = (query: string) => page.evaluate(q => window.engram.botsSearch(q).then(hits => hits.map(hit => hit.id)), query)
const listed = () => page.getByTestId('sidebar-chat-collection').locator('.bots-row').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid')))
const refresh = () => app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'bots:changed' }) })
async function expectNoSearch(): Promise<void> {
  await expect(page.getByTestId('sidebar-search-toggle')).toHaveCount(0)
  await expect(page.getByTestId('app-sidebar').locator('.sidebar-search, input, textarea')).toHaveCount(0)
  await expect(page.getByText('No matches found', { exact: true })).toHaveCount(0)
}

test('a section has no menu or delete dialog; removing it through the app keeps its conversations', async () => {
  await openActivity(page, 'bots')
  const { ids, folder } = await page.evaluate(async () => {
    const first = await window.engram.botCreate({ name: 'Visible deletion fixture' })
    const second = await window.engram.botCreate({ name: 'Hidden deletion fixture' })
    const layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Deletion fixture' } })
    const folder = layout.chat.folders.find(item => item.name === 'Deletion fixture')!
    for (const id of [first.id, second.id]) await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id, folder: folder.id } })
    return { ids: [first.id, second.id], folder: folder.id }
  })
  await expectNoSearch()
  const box = page.getByTestId(`sidebar-folder-${folder}`)
  for (const id of ids) await expect(box.getByTestId(`bot-${id}`)).toBeVisible()
  await page.locator('.sidebar-folder-head', { hasText: 'Deletion fixture' }).click({ button: 'right' })
  await expect(menus()).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Delete section?', exact: true })).toHaveCount(0)
  await capture('section-without-menu.png')
  await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'remove-folder', id } }), folder)
  await expect(box).toHaveCount(0)
  for (const id of ids) await expect(page.getByTestId('sidebar-chats').getByTestId(`bot-${id}`)).toBeVisible()
  expect(await page.evaluate(async ids => (await window.engram.botsList()).filter(bot => ids.includes(bot.id)).length, ids)).toBe(2)
  await page.evaluate(async ids => { for (const id of ids) await window.engram.botDelete(id) }, ids)
  for (const id of ids) await expect(page.getByTestId(`bot-${id}`)).toHaveCount(0)
  expect(await page.evaluate(async ids => (await window.engram.botsList()).some(bot => ids.includes(bot.id)), ids)).toBe(false)
})

test('rows are not draggable: a drag gesture previews no insertion gap and leaves the order alone', async () => {
  const source = page.getByTestId(`bot-${bots[2]!.id}`).locator('..')
  const target = page.getByTestId(`bot-${bots[0]!.id}`).locator('..')
  await target.scrollIntoViewIfNeeded()
  await expect(source).not.toHaveAttribute('draggable')
  await expect(target).not.toHaveAttribute('draggable')
  const order = await listed(), layout = await chatLayout()
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: transfer })
  const box = (await target.boundingBox())!
  await target.dispatchEvent('dragover', { dataTransfer: transfer, clientY: box.y + 4 })
  await expect(page.locator('.sidebar-item[data-insert], .sidebar-item[data-shift], .sidebar-item[data-drag-source], .sidebar-drop-target')).toHaveCount(0)
  expect(await target.locator('.sidebar-item-main').evaluate(node => getComputedStyle(node).translate)).toBe('none')
  await capture('sidebar-no-insertion.png')
  await target.dispatchEvent('drop', { dataTransfer: transfer, clientY: box.y + 4 })
  await source.dispatchEvent('dragend', { dataTransfer: transfer })
  await transfer.dispose()
  await refresh()
  await page.waitForTimeout(300)
  expect(await listed()).toEqual(order)
  expect(await chatLayout()).toEqual(layout)
})

test('conversation rows show persisted previews, timestamps and avatars after reload', async () => {
  const first = page.getByTestId(`bot-${bots[0]!.id}`)
  await expect(first.locator('.sidebar-conversation-name')).toHaveText(bots[0]!.name)
  await expect(first.locator('.sidebar-conversation-preview')).toHaveText('Tomorrow’s checkpoint is ready.')
  await expect(first.locator('.sidebar-conversation-content')).toHaveAttribute('title', new Date(STAMP).toLocaleString('en-US'))
  await expect(first.locator('time')).toHaveCount(0)
  // The orb avatar is a glass ball: one svg holds the wave of light, a second its working overlay.
  await expect(first.locator('.bot-avatar .bot-orb')).toBeVisible()
  await expect(first.locator('.bot-avatar .bot-orb svg')).toHaveCount(2)
  await expect(first.locator('.bot-avatar svg.bot-orb-wave')).toBeVisible()
  await expect(page.getByTestId(`bot-${bots[1]!.id}`).locator('.sidebar-conversation-preview')).toHaveText('You: Please verify the handoff checklist.')
  const saved = await page.evaluate(id => window.engram.botsList().then(list => list.find(bot => bot.id === id)), bots[0]!.id)
  expect(saved?.lastMessage).toMatchObject({ role: 'assistant', text: '**Tomorrow’s checkpoint is ready.**', at: STAMP })
  await first.click()
  await expect(page.getByTestId('bots-thread')).toContainText('Tomorrow’s checkpoint is ready.')
  await page.reload()
  await expect(first.locator('.sidebar-conversation-preview')).toHaveText('Tomorrow’s checkpoint is ready.')
  await expect(first.locator('.sidebar-conversation-content')).toHaveAttribute('title', new Date(STAMP).toLocaleString('en-US'))
})

test('Engram navigation is inside its menu and the menu stays within the window', async () => {
  await showSidebar()
  for (const activity of ['sky', 'list', 'mission']) await expect(page.getByTestId(`activity-${activity}`)).toHaveCount(0)
  await expect(page.getByTestId('activity-bots')).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Workspace mode' })).toHaveCount(0)
  await expect(page.getByTestId('app-sidebar').locator('.sidebar-nav-row')).toHaveCount(0)
  await page.getByTestId('workspace-switcher').click()
  const menu = page.getByTestId('workspace-menu')
  await expect(menu).toBeVisible()
  for (const activity of ['sky', 'list']) await expect(menu.getByTestId(`activity-${activity}`)).toBeVisible()
  await expect(menu.getByTestId('activity-routines')).toHaveCount(0)
  await expect(menu.getByTestId('activity-bots')).toBeVisible()
  await expect(menu.getByTestId('activity-mission')).toHaveCount(0)
  expect(await menu.evaluate(node => {
    const box = node.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
  })).toBe(true)
  await menu.getByTestId('activity-sky').click()
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await expect(menu).toHaveCount(0)
  await openActivity(page, 'bots')
  await page.getByTestId('app-sidebar-close').click()
  await expect(page.getByRole('group', { name: 'Workspace mode' })).toHaveCount(0)
  await page.getByTestId('app-sidebar-open').click()
})

test('the one + opens the new-bot dialog from the keyboard and dismisses, and empty space opens no menu, in both themes', async () => {
  for (const [width, theme] of [[1280, 'light'], [620, 'dark']] as const) {
    await page.setViewportSize({ width, height: 840 })
    await page.evaluate(async theme => window.engram.settingsSet({ ...await window.engram.settingsGet(), theme }), theme)
    await showSidebar()
    await expect(page.locator('.sidebar-create-menu')).toHaveCount(0); await expect(page.getByTestId('bots-new')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-new-folder')).toHaveCount(0)
    const scroll = page.locator('.sidebar-scroll')
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight })
    const box = (await scroll.boundingBox())!
    await scroll.click({ button: 'right', position: { x: 20, y: box.height - 4 } })
    await expect(menus()).toHaveCount(0)
    await expect(page.getByTestId('sidebar-space-new-folder')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-chat-folder-name')).toHaveCount(0)
    await page.getByTestId('sidebar-create').focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('create-bot-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('create-bot-name')).toBeFocused()
    await expect.poll(() => dialog.evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth })).toBe(true)
    await capture(`minimal-create-${theme}.png`)
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
    await showSidebar()
    await scroll.evaluate(node => { node.scrollTop = 0 })
  }
  await page.setViewportSize({ width: 1280, height: 940 })
  await page.evaluate(async () => window.engram.settingsSet({ ...await window.engram.settingsGet(), theme: 'light' }))
})

test('Create stays visible while long conversations scroll', async () => {
  await showSidebar()
  const button = page.getByTestId('sidebar-create')
  await expect(button).toHaveAttribute('aria-label', 'Create')
  const before = await button.boundingBox()
  const scroll = page.locator('.sidebar-scroll')
  expect(await scroll.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
  await scroll.evaluate(node => { node.scrollTop = node.scrollHeight })
  await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  await expect(button).toBeInViewport()
  const after = await button.boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
  await openWelcome(page)
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  // With a primary bot (v2 list) the welcome mark is that bot's own avatar (BotAvatar app-wide); the comet face is only the no-primary fallback.
  await expect(page.locator('.comet-welcome-mark .bot-avatar .bot-orb')).toBeVisible()
  await capture('restored-conversation-icons.png')
  expect(await page.evaluate(() => window.engram.botsList().then(list => list.length))).toBe(bots.length + 1)
})

test('a long-titled conversation in a collapsed folder is reached by opening the folder, without search and without changing organization', async () => {
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
  const head = page.getByTestId(`sidebar-folder-${folderIds.matching}`).getByRole('button', { name: /Release decisions/ }).first()
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  const first = page.getByTestId(`bot-${bots[0]!.id}`)
  await expect(first).not.toBeVisible()
  await expectNoSearch()
  // Message words are still findable where the chat looks them up.
  expect(await found('handoff checklist')).toEqual([bots[1]!.id])
  expect(await found('no matching conversation')).toEqual([])
  await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId(`sidebar-folder-${folderIds.matching}`).getByTestId(`bot-${bots[0]!.id}`)).toBeVisible()
  expect(await first.locator('.sidebar-conversation-name').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
  await expect(page.getByTestId(`sidebar-folder-${folderIds.unrelated}`).getByTestId(`bot-${bots[2]!.id}`)).toBeVisible()
  await expect(page.getByTestId(`bot-${bots[1]!.id}`)).toBeVisible()
  await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'false')
  await expect(first).not.toBeVisible()
  await expect.poll(chatLayout).toEqual(before.chat)
})

test('words that appear only in earlier message bodies are still findable in the store, and that conversation opens from its row', async () => {
  const weekly = bots.at(-1)!
  const row = page.getByTestId(`bot-${weekly.id}`)
  await expectNoSearch()
  for (const query of ['법무팀', '11/16']) expect(await found(query)).toEqual([weekly.id])
  expect(await found('존재하지않는단어')).toEqual([])
  await expect(row).toBeVisible()
  await row.click()
  await expect(row).toHaveClass(/active/)
  await expect(page.getByTestId('bots-thread')).toContainText('법무팀 검토 일정 잡아 주세요')
})

test('the open conversation stays listed and active, with or without an old pin', async () => {
  await showSidebar()
  const open = page.getByTestId(`bot-${bots[2]!.id}`), other = page.getByTestId(`bot-${bots[1]!.id}`)
  const pin = (pinned: boolean) => page.evaluate(({ id, pinned }) => window.engram.sidebarChange({ kind: 'chat', change: { action: 'pin-item', id, pinned } }), { id: bots[2]!.id, pinned })
  await open.click()
  await expect(open).toHaveClass(/active/)
  expect(await page.evaluate(q => window.engram.botsSearch(q), 'zzqx-없는토큰')).toEqual([])
  const order = await listed()
  for (const pinned of [false, true]) {
    if (pinned) await pin(true)
    const before = await chatLayout()
    await refresh()
    await page.waitForTimeout(300)
    await expectNoSearch()
    expect(await listed()).toEqual(order)
    await expect(open).toBeVisible()
    await expect(other).toBeVisible()
    await expect(open).toHaveClass(/active/)
    await expect(page.locator('.app-sidebar [data-pinned]')).toHaveCount(0)
    expect(await chatLayout()).toEqual(before)
  }
  await pin(false)
  await expect(page.locator('.app-sidebar [data-pinned]')).toHaveCount(0)
})

test('sidebar fits light, dark and narrow layouts with captured examples', async () => {
  await showSidebar()
  await page.locator('.sidebar-scroll').evaluate(node => { node.scrollTop = 0 })
  for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 620], ['dark', 620]] as const) {
    await page.setViewportSize({ width, height: 840 })
    await page.evaluate(async value => window.engram.settingsSet({ ...await window.engram.settingsGet(), theme: value }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await showSidebar()
    await expect(page.getByTestId('sidebar-create')).toBeInViewport()
    expect(await page.getByTestId('app-sidebar').evaluate(node => {
      const box = node.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight + 1 && node.scrollWidth <= node.clientWidth
    })).toBe(true)
    await capture(`sidebar-${theme}-${width}.png`)
  }
  await page.setViewportSize({ width: 1280, height: 840 })
})

test('rows have no menu and draw no date; an old pin keeps its row in place and folders intact across reload', async () => {
  await showSidebar()
  await expect(page.getByTestId('sidebar-chats-toggle')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-routine-collection')).toHaveCount(0)
  await expect(page.getByText('Drop here', { exact: true })).toHaveCount(0)
  const id = bots[1]!.id
  const row = page.getByTestId(`bot-${id}`)
  await row.scrollIntoViewIfNeeded()
  await expect(row.locator('xpath=..').locator('.sidebar-more')).toHaveCount(0)
  await row.click({ button: 'right' })
  await expect(menus()).toHaveCount(0)
  const rowBox = await row.boundingBox()
  // The time shows only as a tooltip since the bot sidebar (rd-sidebar-bots, b8646f58), so no date is drawn in the row.
  await expect(row.locator('time')).toHaveCount(0)
  const preview = await row.locator('.sidebar-conversation-preview').boundingBox()
  expect(rowBox!.x + rowBox!.width - preview!.x - preview!.width).toBeLessThan(16)
  const order = await listed()
  await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'pin-item', id, pinned: true } }), id)
  const before = await chatLayout()
  await refresh()
  await page.waitForTimeout(300)
  // The pin stays in the data; the row stays where latest activity puts it, with no pin mark.
  expect(await listed()).toEqual(order)
  await expect(page.getByTestId('sidebar-chats').getByTestId(`bot-${id}`)).toHaveCount(1)
  await expect(row.locator('..').getByLabel('Pinned conversation')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('sidebar-create')).toBeEnabled()
  await expect(row).toBeVisible()
  expect(await listed()).toEqual(order)
  await expect(row.locator('..').getByLabel('Pinned conversation')).toHaveCount(0)
  expect(await chatLayout()).toEqual(before)
  await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'pin-item', id, pinned: false } }), id)
  await expect(row.locator('..').getByLabel('Pinned conversation')).toHaveCount(0)
  await capture('conversation-folders-without-menus.png')
})

test('the welcome has no Web button; a bot made from + opens selected with nothing sent', async () => {
  await showSidebar()
  await openWelcome(page)
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  const draft = 'Check the release checklist on the project website.'
  await page.getByTestId('welcome-input').fill(draft)
  await expect(page.getByTestId('welcome-web')).toHaveCount(0)
  await expect(page.getByTestId('chat-add-menu')).toHaveCount(0)
  await expect(page.getByTestId('welcome-input')).toHaveValue(draft)
  const before = await page.evaluate(() => window.engram.botsList())
  await createBotFromPlus(page, 'Release checklist')
  await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
  await expect(page.locator('[data-testid="bots-view"] [data-testid="bots-input"]')).toBeFocused()
  const after = await page.evaluate(() => window.engram.botsList())
  expect(after).toHaveLength(before.length + 1)
  const created = after.find(bot => !before.some(old => old.id === bot.id))!
  await expect(page.getByTestId(`bot-${created.id}`)).toHaveClass(/active/)
  expect(await page.evaluate(id => localStorage.getItem('engram.comets.selected') === id, created.id)).toBe(true)
  expect(await page.evaluate(id => window.engram.botTranscript(id), created.id)).toEqual([])
  expect(await page.evaluate(() => window.engram.chatActive())).toEqual([])
  await capture('new-bot-from-plus.png')
})

test('there are no split controls; each conversation keeps its own draft in the single view', async () => {
  const current = await page.evaluate(() => localStorage.getItem('engram.comets.selected'))
  expect(current).toBeTruthy()
  for (const id of ['mission-layout-1', 'mission-layout-2', 'mission-layout-4', 'mission-control', 'mission-add-menu']) await expect(page.getByTestId(id)).toHaveCount(0)
  await expect(page.locator('.mission-tile, .mini-chat')).toHaveCount(0)
  await showSidebar()
  const input = page.locator('[data-testid="bots-view"] [data-testid="bots-input"]')
  const mine = page.getByTestId(`bot-${current}`), second = page.getByTestId(`bot-${bots[1]!.id}`)
  await input.fill('')
  await input.pressSequentially('First conversation draft')
  await expect(input).toHaveValue('First conversation draft')
  await second.click()
  await expect(second).toHaveClass(/active/)
  await expect(page.getByTestId('bots-thread')).toContainText('Please verify the handoff checklist.')
  await expect(input).not.toHaveValue('First conversation draft')
  await input.fill('Second conversation draft')
  await mine.click()
  await expect(mine).toHaveClass(/active/)
  await expect(input).toHaveValue('First conversation draft')
  await second.click()
  await expect(second).toHaveClass(/active/)
  await expect(input).toHaveValue('Second conversation draft')
  await capture('single-view-drafts.png')
})

test('conversations follow the latest activity whatever their old pins, live and after relaunch', async () => {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000)
  const [pinned, a, b] = [await createBot(paths, { name: 'Pinned older conversation' }, at(50)), await createBot(paths, { name: 'Pasta conversation' }, at(30)), await createBot(paths, { name: 'Airpods conversation' }, at(18))]
  await appendBotTurn(paths, a.id, { role: 'user', text: 'Pasta?', at: at(20).toISOString() }); await appendBotTurn(paths, b.id, { role: 'assistant', text: 'Airpods.', at: at(16).toISOString() })
  await page.evaluate(id => window.engram.sidebarChange({ kind: 'chat', change: { action: 'pin-item', id, pinned: true } }), pinned.id)
  // The pin is ignored: the pinned bot was last touched longest ago, so it sorts after the other two.
  const order = () => page.getByTestId('sidebar-chat-collection').locator('.bots-row').evaluateAll((nodes, ids) => nodes.map(node => node.getAttribute('data-testid')!.slice(4)).filter(id => ids.includes(id)), [pinned.id, a.id, b.id])
  await openActivity(page, 'bots'); await showSidebar(); await refresh(); await expect.poll(order).toEqual([b.id, a.id, pinned.id])
  await expect(page.locator('.app-sidebar [data-pinned]')).toHaveCount(0)
  await appendBotTurn(paths, a.id, { role: 'assistant', text: 'Fresh pasta.', at: at(1).toISOString() }); await refresh(); await expect.poll(order).toEqual([a.id, b.id, pinned.id])
  await app.close(); await launch(); await openActivity(page, 'bots'); await showSidebar(); await expect.poll(order).toEqual([a.id, b.id, pinned.id])
  await expect(page.locator('.app-sidebar [data-pinned]')).toHaveCount(0)
})
