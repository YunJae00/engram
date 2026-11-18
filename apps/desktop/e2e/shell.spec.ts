import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { openActivity, openWelcome } from './navigation.js'
import { createCard, createNote, initVault, parseNote, type VaultPaths } from 'core'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

let app: ElectronApplication
let page: Page
let paths: VaultPaths

async function frontOf(id: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(paths.notes, `${id}.md`), 'utf8')
    return parseNote(raw).front as unknown as Record<string, unknown>
  } catch {
    return null
  }
}

const palette = () => page.locator('[cmdk-root], [data-testid="palette-input"]')
const menus = () => page.locator('.sidebar-organize-menu, .sidebar-menu, [role="dialog"][aria-label^="Options for"]')

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-'))
  paths = await initVault(root, { git: false })
  await createNote(paths, { id: 'n-hello-0001', body: '# Hello note\n\nThe very first note.' })
  await createNote(paths, { id: 'n-rule-0001', body: '# Deploy day\n\nWe deploy on Tuesdays.' })
  await createCard(paths, {
    cardType: 'supersede',
    targets: ['n-rule-0001'],
    rationale: 'Deploy day moved to Friday',
    proposed: '# Deploy day\n\nWe deploy on Fridays.',
  })
  await createNote(paths, {
    id: 'n-kick-0001',
    body: '# Kickoff\n\nProject kickoff meeting.',
    happened_at: '2026-02-01',
    timeline: 'pinned',
  })
  await createNote(paths, {
    id: 'n-ship-0001',
    body: '# First ship\n\nv0 went out.',
    happened_at: '2026-03-01',
    timeline: 'pinned',
  })
  await createNote(paths, { id: 'n-mid-0001', body: '# Midpoint check\n\nSomewhere between kickoff and ship.' })
  await createNote(paths, { id: 'n-ref-0001', body: '# Style guide\n\nTimeless reference material.' })
  await createNote(paths, { id: 'n-argo-0001', body: '# Argo redesign\n\nThe umbrella decision.' })
  await createNote(paths, { id: 'n-argo-0002', body: '# Argo palette\n\nColor decisions.', derived_from: ['n-argo-0001'] })
  await createNote(paths, { id: 'n-argo-0003', body: '# Argo typography\n\nType decisions.', derived_from: ['n-argo-0001'] })
  await mkdir(paths.views, { recursive: true })
  await writeFile(join(paths.views, 'digest-2026-07-12.md'), '# Weekly digest\n\n## What accumulated\n\n- pricing notes.\n', 'utf8')

  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      ENGRAM_USERDATA: await mkdtemp(join(REPO_TMP, 'e2e-shell-userdata-')),
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[renderer pageerror]', err))
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[renderer console.error]', msg.text())
  })
})

test.afterAll(async () => {
  await app?.close()
})

test('boots into the minimal shell on a temp vault', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('topbar')).toBeVisible()
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await openActivity(page, 'sky')
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await expect(page.getByTestId('brain-graph')).toBeVisible()
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
})

test('no engine → connect banner shows', async () => {
  const banner = page.getByTestId('connect-banner')
  await expect(banner).toBeVisible()
  const [topbarBox, bannerBox, canvasBox] = await Promise.all([
    page.getByTestId('topbar').boundingBox(),
    banner.boundingBox(),
    page.locator('.canvas').boundingBox(),
  ])
  expect(topbarBox && bannerBox && canvasBox).not.toBeNull()
  const [t, b] = [topbarBox!, bannerBox!]
  expect(b.x >= t.x - 1 && b.y >= t.y - 1 && b.x + b.width <= t.x + t.width + 1 && b.y + b.height <= t.y + t.height + 1).toBe(true)
  await expect(page.locator('.notices [data-testid="connect-banner"]')).toHaveCount(0)
  expect(canvasBox!.y).toBeGreaterThanOrEqual(topbarBox!.y + topbarBox!.height - 1)
  await banner.getByRole('button', { name: 'AI settings' }).click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
})

test('the Engram menu only navigates', async () => {
  await page.getByTestId('engram-menu-button').click()
  await expect(page.getByTestId('engram-menu')).toBeVisible()
  expect(await page.getByTestId('engram-menu').getByRole('button').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')))).toEqual(['activity-bots', 'activity-sky', 'activity-list'])
  await expect(page.getByTestId('engram-menu').locator('summary')).toHaveCount(0)
  await expect(page.getByTestId('engram-menu')).not.toContainText(/workspace/i)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('engram-menu')).toHaveCount(0)
})

test('help lives in Settings without duplicate quick actions', async () => {
  await expect(page.getByTestId('help-button')).toHaveCount(0)
  await openActivity(page, 'settings')
  await expect(page.getByTestId('help-panel')).toHaveCount(0)
  const panel = page.getByTestId('settings-about')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Engram', exact: true })).toBeVisible()
  await expect(panel).not.toContainText('Keyboard shortcuts')
  await expect(panel.getByTestId('settings-version')).toBeVisible()
  await expect(page.getByTestId('settings-export-logs')).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Remember' })).toHaveCount(0)
  await page.getByTestId('settings-view').getByRole('button', { name: 'Close settings', exact: true }).click()
})


test('the cosmos chat collapses and comes back', async () => {
  await openActivity(page, 'sky')
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
  const openSkyWidth = (await page.getByTestId('sky-view').boundingBox())!.width
  await page.getByTitle('Hide', { exact: true }).click()
  await expect(page.getByTestId('cosmos-chat')).toHaveCount(0)
  await expect(page.getByTestId('cosmos-chat-open')).toContainText('Ask your memory')
  const foldedSkyWidth = (await page.getByTestId('sky-view').boundingBox())!.width
  expect(Math.abs(openSkyWidth - foldedSkyWidth)).toBeLessThanOrEqual(1)
  await page.getByTestId('cosmos-chat-open').click()
  await expect(page.getByTestId('cosmos-chat-input')).toBeVisible()
})

test('the app sidebar lists chats only, shows a rename made through the app, has no routines library, and folds away', async () => {
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  const sidebar = page.getByTestId('app-sidebar')
  await expect(page.getByTestId('sidebar-search-toggle')).toHaveCount(0)
  await expect(sidebar.locator('.sidebar-search, input, textarea')).toHaveCount(0)
  await expect(sidebar.locator('.sidebar-nav')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-chats-toggle')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-routines-toggle')).toHaveCount(0)
  const engineStatus = sidebar.getByTestId('engine-status')
  await expect(engineStatus).toHaveCount(0)
  await expect(sidebar.getByTestId('sweep-status')).toHaveCount(0)
  await expect(sidebar.getByTestId('filing-retry')).toHaveCount(0)
  const [scrollBox, engineBox, footerBox] = await Promise.all([
    sidebar.locator('.sidebar-scroll').boundingBox(),
    sidebar.getByTestId('activity-settings').boundingBox(),
    sidebar.locator('.sidebar-footer').boundingBox(),
  ])
  expect(footerBox!.y).toBeGreaterThanOrEqual(scrollBox!.y + scrollBox!.height - 1)
  expect(engineBox!.y).toBeGreaterThanOrEqual(footerBox!.y)
  expect(engineBox!.y + engineBox!.height).toBeLessThanOrEqual(footerBox!.y + footerBox!.height)
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Scout', purpose: 'finds things out' }))
  await openActivity(page, 'bots')
  await expect(page.getByTestId('sidebar-chats')).toContainText('Scout')
  const alignment = await sidebar.evaluate(node => {
    const head = node.querySelector('.app-sidebar-head')!.getBoundingClientRect()
    const tools = node.querySelector('.sidebar-library-tools')!.getBoundingClientRect()
    const row = node.querySelector('.sidebar-conversations .sidebar-item')!.getBoundingClientRect()
    if (node.querySelector('.sidebar-tree-head, [data-testid="sidebar-new-folder"]')) throw new Error('the Bots head row is back')
    const content = node.querySelector('.sidebar-scroll')!.getBoundingClientRect()
    const side = node.getBoundingClientRect()
    return { left: tools.left - row.left, right: row.right - tools.right, rowLeft: row.left - side.left, rowRight: side.right - row.right, above: tools.top - head.bottom, below: content.top - tools.bottom }
  })
  expect(Math.abs(alignment.rowLeft - 8)).toBeLessThanOrEqual(2)
  expect(Math.abs(alignment.rowRight - 8)).toBeLessThanOrEqual(2)
  expect(Math.abs(alignment.left - 4)).toBeLessThanOrEqual(2)
  expect(Math.abs(alignment.right - 4)).toBeLessThanOrEqual(2)
  expect(alignment.above).toBeCloseTo(12, 1)
  expect(alignment.below).toBeCloseTo(12, 1)

  await expect(page.getByTestId(`sidebar-chat-menu-${bot.id}`)).toHaveCount(0)
  await page.getByTestId(`bot-${bot.id}`).click({ button: 'right' })
  await expect(menus()).toHaveCount(0)
  await expect(page.getByTestId(`sidebar-chat-name-${bot.id}`)).toHaveCount(0)
  await page.evaluate(id => window.engram.botRename(id, 'Field Scout'), bot.id)
  await expect(page.getByTestId('sidebar-chats')).toContainText('Field Scout')
  await expect.poll(async () => (await page.evaluate(() => window.engram.botsList())).some((item) => item.name === 'Field Scout')).toBe(true)

  const routine = await page.evaluate(() => window.engram.routineAdd({ name: 'Portal notices', steps: [{ kind: 'open', url: 'https://example.com/notices' }] }))
  const routineNames = () => page.evaluate(() => window.engram.routinesList().then(list => list.map(one => one.name)))
  const expectNoLibrary = async () => {
    await expect(page.getByTestId('sidebar-routines')).toHaveCount(0)
    await expect(page.locator('[data-testid^="sidebar-routine"], [data-testid="routines-view"], [data-testid="activity-routines"]')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-chats')).toBeVisible()
  }
  await expectNoLibrary()
  const chatsBefore = await page.evaluate(() => window.engram.botsList().then(bots => bots.length))
  await page.evaluate(id => window.engram.routineRename(id, 'Morning portal'), routine.id)
  expect(await routineNames()).toEqual(['Morning portal'])
  await page.evaluate(() => { window.dispatchEvent(new Event('engram:open-routines')) })
  await expectNoLibrary()
  expect(await page.evaluate(() => window.engram.botsList().then(bots => bots.length))).toBe(chatsBefore)
  expect(await page.evaluate(() => window.engram.chatActive())).toEqual([])

  await openActivity(page, 'bots')
  await expect(page.getByTestId('sidebar-chats')).toBeVisible()
  await expect(page.getByTestId('sidebar-routines')).toHaveCount(0)

  await page.getByTestId('app-sidebar-close').click()
  await expect(page.getByTestId('app-sidebar')).not.toBeVisible()
  await expect(page.getByTestId('app-sidebar-open')).toBeVisible()
  await page.getByTestId('app-sidebar-open').click()
  await expect(page.getByTestId('app-sidebar')).toBeVisible()

  await openWelcome(page)
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  await expect(page.getByTestId('bots-suggestion')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await openActivity(page, 'bots')
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await expect(page.getByTestId('bots-suggestion')).toHaveCount(0)
  await expect(page.getByTestId(`bot-${bot.id}`)).toContainText('Field Scout')
  expect(await page.evaluate(() => window.engram.routinesList().then(list => list.map(one => one.name)))).toEqual(['Morning portal'])
  await expect(page.getByTestId('sidebar-routines')).toHaveCount(0)
  await openActivity(page, 'sky')
})

test('help is reachable through Settings on every view', async () => {
  for (const view of ['bots', 'sky']) {
    await openActivity(page, view)
    await openActivity(page, 'settings')
    await expect(page.getByTestId('settings-about')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-about')).toHaveCount(0)
  }
})

test('the command shortcut opens no palette; Help is reached through Settings', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(palette()).toHaveCount(0)
  await expect(page.getByRole('option', { name: 'Read the weekly digest' })).toHaveCount(0)
  await openActivity(page, 'settings')
  await expect(page.getByTestId('settings-about')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('help-panel')).toHaveCount(0)
})

test('folders made through the app hold their items, fold, persist, offer no drag or keyboard rename, and are removed without deleting anything', async () => {
  for (const kind of ['chat', 'routine'] as const) {
    await openActivity(page, 'bots')
    const ids = await page.evaluate(async kind => {
      const result: string[] = []
      for (const name of ['Alpha', 'Beta']) result.push(kind === 'chat' ? (await window.engram.botCreate({ name: `${kind} ${name}` })).id : (await window.engram.routineAdd({ name: `${kind} ${name}`, steps: [{ kind: 'open', url: 'https://example.com' }] })).id)
      return result
    }, kind)
    await page.evaluate(async ({ kind, ids }) => {
      const layout = await window.engram.sidebarChange({ kind, change: { action: 'create-folder', name: `${kind} Work` } })
      const folder = layout[kind].folders.find(one => one.name === `${kind} Work`)!.id
      for (const id of ids) await window.engram.sidebarChange({ kind, change: { action: 'move-item', id, folder } })
    }, { kind, ids })
    const layoutOf = async () => (await page.evaluate(() => window.engram.sidebarLayout()))[kind]
    await expect.poll(async () => (await layoutOf()).folders.length).toBe(1)
    const folder = (await layoutOf()).folders[0]!
    expect((await layoutOf()).items.filter(one => one.folder === folder.id).map(one => one.id)).toEqual(ids)
    const remove = () => page.evaluate(({ kind, id }) => window.engram.sidebarChange({ kind, change: { action: 'remove-folder', id } }), { kind, id: folder.id })
    if (kind === 'routine') {
      await expect(page.getByTestId(`sidebar-folder-${folder.id}`)).toHaveCount(0)
      await expect(page.locator('[data-testid^="sidebar-routine"]')).toHaveCount(0)
      await remove()
      expect((await layoutOf()).folders).toEqual([])
      expect((await page.evaluate(() => window.engram.routinesList())).map(one => one.id)).toEqual(expect.arrayContaining(ids))
      continue
    }
    const box = page.getByTestId(`sidebar-folder-${folder.id}`)
    const item = (id: string) => page.getByTestId(`bot-${id}`)
    const collection = page.getByTestId('sidebar-chat-collection')
    for (const id of ids) {
      await expect(box.getByTestId(`bot-${id}`)).toBeVisible()
      await expect(item(id).locator('xpath=..')).not.toHaveAttribute('draggable')
    }
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    try {
      const source = item(ids[1]!).locator('xpath=..'), destination = item(ids[0]!)
      await source.dispatchEvent('dragstart', { dataTransfer })
      expect(await dataTransfer.evaluate(data => data.getData('application/x-engram-sidebar'))).toBe('')
      await destination.dispatchEvent('dragover', { dataTransfer })
      await expect(collection).not.toHaveClass(/dragging/)
      await expect(collection.locator('.sidebar-drop-target, .sidebar-item[data-insert]')).toHaveCount(0)
      await destination.dispatchEvent('drop', { dataTransfer })
      await source.dispatchEvent('dragend', { dataTransfer })
    } finally { await dataTransfer.dispose() }
    expect((await layoutOf()).items.filter(one => one.folder === folder.id).map(one => one.id)).toEqual(ids)
    await box.getByRole('button', { name: new RegExp(`${kind} Work`) }).first().click()
    await expect(item(ids[0]!)).not.toBeVisible()
    await page.reload()
    await openActivity(page, 'bots')
    await expect(box).toBeVisible()
    await expect(item(ids[0]!)).not.toBeVisible()
    await box.getByRole('button', { name: new RegExp(`${kind} Work`) }).first().click()
    await expect(item(ids[0]!)).toBeVisible()
    await item(ids[0]!).locator('xpath=..').focus()
    await page.keyboard.press('F2')
    await expect(page.getByTestId(`sidebar-${kind}-name-${ids[0]}`)).toHaveCount(0)
    await expect(page.locator('.app-sidebar [role="tree"] input')).toHaveCount(0)
    await expect(item(ids[0]!)).toHaveAttribute('title', `${kind} Alpha`)
    await item(ids[0]!).click({ button: 'right' })
    await expect(menus()).toHaveCount(0)
    await box.locator(':scope > .sidebar-folder-head').click({ button: 'right' })
    await expect(menus()).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Delete section?', exact: true })).toHaveCount(0)
    await expect(box).toBeVisible()
    await remove()
    await expect(box).toHaveCount(0)
    for (const id of ids) await expect(item(id)).toBeVisible()
  }
  await openActivity(page, 'sky')
})

test('Ctrl+L opens nothing; the comets tab is reached from the workspace menu', async () => {
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+l')
  await expect(palette()).toHaveCount(0)
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await expect(page.getByTestId('bots-view')).not.toBeVisible()
  await openActivity(page, 'bots')
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await expect(page.getByTestId('cosmos-chat')).toHaveCount(0)
  await openActivity(page, 'sky')
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
})

test('clicking a star in the cosmos opens the note sheet with editor and meta bar', async () => {
  await openActivity(page, 'sky')
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await page.getByTestId('cosmos-chat-collapse').click()
  await expect(page.getByTestId('cosmos-chat')).toHaveCount(0)
  await page.locator('[data-node-id="n-hello-0001"]').click()
  await expect(page.getByTestId('note-sheet')).toBeVisible()
  await expect(page.getByTestId('note-editor')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await expect(page.getByTestId('meta-bar')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-sheet')).toHaveCount(0)
})

test('hovering a star lights its neighbours and lets the rest of the sky recede', async () => {
  await openActivity(page, 'sky')
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await page.locator('[data-node-id="n-argo-0002"]').hover()
  await expect(page.locator('[data-node-id="n-argo-0002"]')).toHaveAttribute('data-sky-state', 'emph')
  await expect(page.locator('[data-node-id="n-argo-0001"]')).toHaveAttribute('data-sky-state', 'emph')
  await expect(page.locator('[data-node-id="n-hello-0001"]')).toHaveAttribute('data-sky-state', 'dim')
  const box = (await page.getByTestId('brain-graph').boundingBox())!
  await page.mouse.move(box.x + 6, box.y + box.height - 6)
  await expect(page.locator('[data-node-id="n-argo-0001"]')).not.toHaveAttribute('data-sky-state', /.*/)
  await expect(page.locator('[data-node-id="n-hello-0001"]')).not.toHaveAttribute('data-sky-state', /.*/)
})

test('Ctrl+P opens no quick-open palette; a note still opens from its star', async () => {
  await openActivity(page, 'sky')
  await page.keyboard.press('ControlOrMeta+p')
  await expect(palette()).toHaveCount(0)
  await expect(page.getByTestId('note-sheet')).toHaveCount(0)
  await page.locator('[data-node-id="n-hello-0001"]').click()
  await expect(page.getByTestId('note-editor')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-sheet')).toHaveCount(0)
})

test('file and text drops do not capture memories or navigate the app', async () => {
  const before = (await readdir(paths.inbox)).filter((f) => f.endsWith('.md')).length
  await expect(page.getByTestId('shell')).toBeVisible()
  const url = page.url()
  const prevented = await page.evaluate(() => {
    const target = document.querySelector('[data-testid="shell"]')!
    return ['text', 'file'].map((kind) => {
      const data = new DataTransfer()
      if (kind === 'text') data.setData('text/plain', 'dropped e2e memo')
      else data.items.add(new File(['fixture'], 'attachment.txt', { type: 'text/plain' }))
      const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    })
  })
  expect(prevented).toEqual([true, true])
  await expect(page.locator('.drop-overlay')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(palette()).toHaveCount(0)
  await expect(page.getByRole('option', { name: /Import/i })).toHaveCount(0)
  expect(page.url()).toBe(url)
  expect((await readdir(paths.inbox)).filter((f) => f.endsWith('.md')).length).toBe(before)
})

test('list view: rows render chronologically, the filter narrows them, a row opens the note sheet', async () => {
  await openActivity(page, 'list')
  await expect(page.getByTestId('list-view')).toBeVisible()
  await expect.poll(() => page.getByTestId('list-row').count()).toBeGreaterThan(1)
  const before = await page.getByTestId('list-row').count()
  const dates = await page.locator('.list-date').allTextContents()
  expect(dates.length).toBeGreaterThan(1)
  expect([...dates].sort().reverse()).toEqual(dates)
  await expect(
    page.getByTestId('list-row').filter({ hasText: 'Kickoff' }).locator('.list-date'),
  ).toHaveText('2026-02-01')
  await page.getByTestId('list-filter').fill('Hello')
  await expect.poll(() => page.getByTestId('list-row').count()).toBeLessThan(before)
  await expect(page.getByTestId('list-row')).toHaveCount(1)
  await page.getByTestId('list-row').first().click()
  await expect(page.getByTestId('note-sheet')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-sheet')).toHaveCount(0)
})

test('approving the seeded supersede card flips frontmatter, with no palette or review sheet to go through', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(palette()).toHaveCount(0)
  await expect(page.getByTestId('review-sheet')).toHaveCount(0)
  const card = (await page.evaluate(() => window.engram.listCards())).find(one => one.cardType === 'supersede' && one.targets.includes('n-rule-0001'))!
  expect(card.status).toBe('proposed')
  await page.evaluate(id => window.engram.approveCard(id, {}), card.id)
  await expect
    .poll(async () => (await frontOf('n-rule-0001'))?.['status'] ?? 'pending', { timeout: 20_000 })
    .toBe('superseded')
  const noteFiles = await readdir(paths.notes)
  let replacementFound = false
  for (const file of noteFiles) {
    const note = parseNote(await readFile(join(paths.notes, file), 'utf8'))
    if (note.front.supersedes.includes('n-rule-0001')) {
      replacementFound = true
      expect(note.body).toContain('Fridays')
    }
  }
  expect(replacementFound).toBe(true)
})
