import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { openActivity } from './navigation.js'
import { createCard, createNote, initVault, parseNote, type VaultPaths } from 'core'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// M3 acceptance e2e: boot → temp vault, capture via UI → file lands, open a
// note, approve a seeded supersede card (A) → frontmatter changes, palette
// quick-open. Serial — one app instance for the whole flow.

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

let app: ElectronApplication
let page: Page
let paths: VaultPaths

// Reads a note's frontmatter, tolerating mid-write partial files on the slow
// filesystem — pollers retry instead of aborting on a parse error.
async function frontOf(id: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(paths.notes, `${id}.md`), 'utf8')
    return parseNote(raw).front as unknown as Record<string, unknown>
  } catch {
    return null
  }
}

test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-'))
  paths = await initVault(root, { git: false })
  // Seed: one plain note + a v1 note with a proposed supersede card.
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
  // A linked cluster: three notes joined by derived_from, so the sky has a
  // constellation to draw.
  await createNote(paths, { id: 'n-argo-0001', body: '# Argo redesign\n\nThe umbrella decision.' })
  await createNote(paths, { id: 'n-argo-0002', body: '# Argo palette\n\nColor decisions.', derived_from: ['n-argo-0001'] })
  await createNote(paths, { id: 'n-argo-0003', body: '# Argo typography\n\nType decisions.', derived_from: ['n-argo-0001'] })
  // A written J10 digest, so the sheet it moved to renders the real thing
  // instead of only its empty line.
  await mkdir(paths.views, { recursive: true })
  await writeFile(join(paths.views, 'digest-2026-07-12.md'), '# Weekly digest\n\n## What accumulated\n\n- pricing notes.\n', 'utf8')

  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: {
      ...process.env,
      ENGRAM_VAULT: root,
      // Its own userData, like every other spec: without this the test
      // shares the installed app's state, and boots against a vault that
      // app may be holding open right now.
      ENGRAM_USERDATA: await mkdtemp(join(REPO_TMP, 'e2e-shell-userdata-')),
      ENGRAM_NO_GIT: '1',
      ENGRAM_NO_AUTOTIDY: '1',
      ENGRAM_ENGINE: 'none',
      ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  // Surface renderer crashes/errors directly in the test log.
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
  // Comets are home: the app opens on the work, and the sky is one tab over.
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await openActivity(page, 'sky')
  await expect(page.getByTestId('sky-view')).toBeVisible()
  // The seeded memories render as stars.
  await expect(page.getByTestId('brain-graph')).toBeVisible()
  // Asking (and keeping) is a docked panel on the cosmos's right edge.
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
})

test('no engine → connect banner shows', async () => {
  // ENGRAM_ENGINE=none: the librarian is offline, so the canvas carries the
  // connect nudge and Tidy wears the pending count (no sweep has ever run, so
  // every seeded note counts as not-yet-organized).
  const banner = page.getByTestId('connect-banner')
  await expect(banner).toBeVisible()
  const [topbarBox, noticesBox, canvasBox] = await Promise.all([
    page.getByTestId('topbar').boundingBox(),
    page.locator('.notices').boundingBox(),
    page.locator('.canvas').boundingBox(),
  ])
  expect(topbarBox).not.toBeNull()
  expect(noticesBox).not.toBeNull()
  expect(canvasBox).not.toBeNull()
  expect(noticesBox!.y).toBeGreaterThanOrEqual(topbarBox!.y + topbarBox!.height - 1)
  expect(canvasBox!.y).toBeGreaterThanOrEqual(noticesBox!.y + noticesBox!.height - 1)
  await banner.getByRole('button', { name: 'Connect a brain' }).click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
})

test('workspace switcher shows the active workspace', async () => {
  // Registry is empty here (launched with ENGRAM_VAULT) — currentName falls back
  // to 'Engram' but the menu still renders the New/Join rows.
  await page.getByTestId('workspace-switcher').click()
  await expect(page.getByTestId('workspace-menu')).toBeVisible()
  await expect(page.getByTestId('workspace-menu').getByRole('button', { name: /New workspace/ })).not.toBeVisible()
  await page.getByTestId('workspace-menu').locator('summary').click()
  await expect(page.getByTestId('workspace-menu').getByRole('button', { name: /New workspace/ })).toBeVisible()
  await expect(page.getByTestId('workspace-menu')).toContainText('New workspace')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workspace-menu')).toHaveCount(0)
})

test('help lives in Settings without duplicate quick actions', async () => {
  await expect(page.getByTestId('help-button')).toHaveCount(0)
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-help').click()
  const panel = page.getByTestId('help-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('A small guide to Engram')
  await expect(panel).toContainText('Keyboard shortcuts')
  await expect(panel.getByRole('button', { name: 'Remember' })).toHaveCount(0)
  await page.keyboard.press('Escape')
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

test('the app sidebar switches between chats and saved routines, renames them, and folds away', async () => {
  await expect(page.getByTestId('shell')).toBeVisible({ timeout: 60_000 })
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  const sidebar = page.getByTestId('app-sidebar')
  await expect(sidebar.getByRole('textbox', { name: 'Search conversations' })).toBeVisible()
  await expect(sidebar.locator('.sidebar-nav')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-chats-toggle')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-routines-toggle')).toHaveCount(0)
  const engineStatus = sidebar.getByTestId('engine-status')
  await expect(engineStatus).toBeVisible()
  const [scrollBox, engineBox, footerBox] = await Promise.all([
    sidebar.locator('.sidebar-scroll').boundingBox(),
    engineStatus.boundingBox(),
    sidebar.locator('.sidebar-footer').boundingBox(),
  ])
  expect(footerBox!.y).toBeGreaterThanOrEqual(scrollBox!.y + scrollBox!.height - 1)
  expect(engineBox!.y).toBeGreaterThanOrEqual(footerBox!.y)
  expect(engineBox!.y + engineBox!.height).toBeLessThanOrEqual(footerBox!.y + footerBox!.height)
  const bot = await page.evaluate(() => window.engram.botCreate({ name: 'Scout', purpose: 'finds things out' }))
  await openActivity(page, 'bots')
  await expect(page.getByTestId('sidebar-chats')).toContainText('Scout')

  await page.getByTestId(`sidebar-chat-menu-${bot.id}`).click()
  await expect(page.getByRole('dialog', { name: 'Options for Scout' }).getByRole('button')).toHaveText(['Rename', 'Pin', 'Delete'])
  await page.getByTestId(`sidebar-chat-rename-${bot.id}`).click()
  await page.getByTestId(`sidebar-chat-name-${bot.id}`).fill('Field Scout')
  await page.getByTestId(`sidebar-chat-name-${bot.id}`).press('Enter')
  await expect(page.getByTestId('sidebar-chats')).toContainText('Field Scout')
  await expect.poll(async () => (await page.evaluate(() => window.engram.botsList())).some((item) => item.name === 'Field Scout')).toBe(true)

  const routine = await page.evaluate(() => window.engram.routineAdd({ name: 'Portal notices', steps: [{ kind: 'open', url: 'https://example.com/notices' }] }))
  await expect(page.getByTestId('sidebar-routines')).toHaveCount(0)
  await openActivity(page, 'routines')
  await expect(sidebar.getByRole('textbox', { name: 'Search routines' })).toBeVisible()
  await expect(page.getByTestId('sidebar-chats')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-routines')).toContainText('Portal notices')
  await page.getByTestId(`sidebar-routine-menu-${routine.id}`).click()
  await expect(page.getByRole('dialog', { name: 'Options for Portal notices' }).getByRole('button')).toHaveText(['Rename', 'Delete'])
  await page.getByTestId(`sidebar-routine-rename-${routine.id}`).click()
  await page.getByTestId(`sidebar-routine-name-${routine.id}`).fill('Morning portal')
  await page.getByTestId(`sidebar-routine-name-${routine.id}`).press('Enter')
  await expect(page.getByTestId('sidebar-routines')).toContainText('Morning portal')
  const chatsBefore = await page.evaluate(() => window.engram.botsList().then(bots => bots.length))
  await page.getByTestId(`sidebar-routine-run-${routine.id}`).click()
  await expect(page.getByTestId(`routine-detail-${routine.id}`).getByRole('heading', { name: 'Morning portal' })).toBeVisible()
  expect(await page.evaluate(() => window.engram.botsList().then(bots => bots.length))).toBe(chatsBefore)

  await openActivity(page, 'bots')
  await expect(page.getByTestId('sidebar-chats')).toBeVisible()
  await expect(page.getByTestId('sidebar-routines')).toHaveCount(0)

  await page.getByTestId('app-sidebar-close').click()
  await expect(page.getByTestId('app-sidebar')).not.toBeVisible()
  await expect(page.getByTestId('app-sidebar-open')).toBeVisible()
  await page.getByTestId('app-sidebar-open').click()
  await expect(page.getByTestId('app-sidebar')).toBeVisible()

  await page.getByTestId('bots-new').click()
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  await expect(page.getByTestId('bots-suggestion')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await openActivity(page, 'bots')
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await expect(page.getByTestId('bots-suggestion')).toHaveCount(0)
  await expect(page.getByTestId(`bot-${bot.id}`)).toContainText('Field Scout')
  await openActivity(page, 'routines')
  await expect(page.getByTestId('sidebar-routines')).toContainText('Morning portal')
  await openActivity(page, 'sky')
})

test('help is reachable through Settings on every view', async () => {
  for (const view of ['bots', 'sky']) {
    await openActivity(page, view)
    await openActivity(page, 'settings')
    await page.getByTestId('settings-nav-help').click()
    await expect(page.getByTestId('help-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('help-panel')).toHaveCount(0)
  }
})

test('commands open Help in Settings instead of redundant quick actions', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('weekly digest')
  await expect(page.getByRole('option', { name: 'Read the weekly digest' })).toHaveCount(0)
  await page.getByTestId('palette-input').fill('Help')
  await page.getByRole('option', { name: 'Help', exact: true }).click()
  await expect(page.getByTestId('help-panel')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('folders support drag reordering, keyboard rename cancellation, persistence, and non-destructive removal', async () => {
  for (const kind of ['chat', 'routine'] as const) {
    await openActivity(page, kind === 'chat' ? 'bots' : 'routines')
    const ids = await page.evaluate(async kind => {
      const result: string[] = []
      for (const name of ['Alpha', 'Beta']) result.push(kind === 'chat' ? (await window.engram.botCreate({ name: `${kind} ${name}` })).id : (await window.engram.routineAdd({ name: `${kind} ${name}`, steps: [{ kind: 'open', url: 'https://example.com' }] })).id)
      return result
    }, kind)
    await page.getByRole('button', { name: kind === 'chat' ? 'New chat folder' : 'New routine folder' }).click()
    const input = page.getByTestId(`sidebar-${kind}-folder-name`)
    await input.fill(`${kind} Work`)
    await input.press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.engram.sidebarLayout()))[kind].folders.length).toBe(1)
    const folder = (await page.evaluate(() => window.engram.sidebarLayout()))[kind].folders[0]!
    const box = page.getByTestId(`sidebar-folder-${folder.id}`)
    const item = (id: string) => page.getByTestId(kind === 'chat' ? `bot-${id}` : `sidebar-routine-run-${id}`)
    // Hidden windows cannot reliably complete native drag interception; exercise the HTML5 lifecycle.
    const drag = async (id: string, destination: Locator, after = false) => {
      const source = item(id).locator('xpath=..'), collection = page.getByTestId(`sidebar-${kind}-collection`)
      await expect(source).toBeVisible(); await expect(source).toHaveAttribute('draggable', 'true')
      await expect(destination).toBeVisible()
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
      try {
        await source.dispatchEvent('dragstart', { dataTransfer })
        expect(await dataTransfer.evaluate(data => JSON.parse(data.getData('application/x-engram-sidebar')))).toEqual({ type: 'item', id, kind })
        await expect(collection).toHaveClass(/dragging/)
        const point = await destination.evaluate((node, after) => { const rect = node.getBoundingClientRect(); return { clientX: rect.left + Math.min(40, rect.width / 2), clientY: rect.top + (after ? rect.height - 3 : 3) } }, after)
        await destination.dispatchEvent('dragenter', { dataTransfer, ...point })
        expect(await destination.evaluate((node, init) => { const event = new DragEvent('dragover', { ...init, bubbles: true, cancelable: true }); node.dispatchEvent(event); return event.defaultPrevented }, { dataTransfer, ...point })).toBe(true)
        await expect.poll(() => destination.evaluate(node => !!node.closest('.sidebar-drop-target'))).toBe(true)
        await destination.dispatchEvent('drop', { dataTransfer, ...point })
      } finally {
        await source.dispatchEvent('dragend', { dataTransfer })
        await dataTransfer.dispose()
      }
      await expect(collection).not.toHaveClass(/dragging/)
      await expect(collection.locator('.sidebar-drop-target')).toHaveCount(0)
    }
    for (const id of ids) {
      await drag(id, box.locator('.sidebar-folder-head'))
      await expect(box).toContainText(id === ids[0] ? `${kind} Alpha` : `${kind} Beta`)
    }
    await drag(ids[1]!, item(ids[0]!))
    await expect.poll(async () => (await page.evaluate(() => window.engram.sidebarLayout()))[kind].items.filter(one => one.folder === folder.id).map(one => one.id)).toEqual([ids[1], ids[0]])
    await drag(ids[1]!, item(ids[0]!), true)
    await expect.poll(async () => (await page.evaluate(() => window.engram.sidebarLayout()))[kind].items.filter(one => one.folder === folder.id).map(one => one.id)).toEqual(ids)
    await box.getByRole('button', { name: new RegExp(`${kind} Work`) }).first().click()
    await expect(item(ids[0]!)).not.toBeVisible()
    await page.reload()
    await openActivity(page, kind === 'chat' ? 'bots' : 'routines')
    await expect(box).toBeVisible()
    await expect(item(ids[0]!)).not.toBeVisible()
    await box.getByRole('button', { name: new RegExp(`${kind} Work`) }).first().click()
    await expect(item(ids[0]!)).toBeVisible()
    await page.getByTestId(`sidebar-${kind}-menu-${ids[0]}`).click()
    await page.getByTestId(`sidebar-${kind}-rename-${ids[0]}`).click()
    await page.getByTestId(`sidebar-${kind}-name-${ids[0]}`).fill('Do not save this')
    await page.getByTestId(`sidebar-${kind}-name-${ids[0]}`).press('Escape')
    await expect(item(ids[0]!)).toHaveAttribute('title', `${kind} Alpha`)
    await box.getByRole('button', { name: `Options for ${kind} Work`, exact: true }).click()
    const menu = page.getByRole('dialog', { name: `Options for ${kind} Work`, exact: true })
    await menu.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(box).toBeVisible()
    await page.getByRole('dialog', { name: 'Delete folder?', exact: true }).getByRole('button', { name: 'Delete folder only', exact: true }).click()
    await expect(box).toHaveCount(0)
    for (const id of ids) await expect(item(id)).toBeVisible()
  }
  await openActivity(page, 'sky')
})

test('Ctrl+L is the door to the comets tab', async () => {
  await page.keyboard.press('ControlOrMeta+l')
  await expect(page.getByTestId('bots-view')).toBeVisible()
  // and the cosmos furniture stays off this tab
  await expect(page.getByTestId('cosmos-chat')).toHaveCount(0)
  await openActivity(page, 'sky')
  await expect(page.getByTestId('cosmos-chat')).toBeVisible()
})

test('clicking a star in the cosmos opens the note sheet with editor and meta bar', async () => {
  // The sky is home — every seeded memory renders as a clickable star.
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
  // The sky exists to answer "what is this connected to". n-argo-0002 is
  // derived_from n-argo-0001, so that one burns with it; n-hello-0001 is a
  // stranger and dims. The canvas draws the alpha field; the ghosts carry the
  // settled state so a driver (and a screen reader) can read it.
  await openActivity(page, 'sky')
  await expect(page.getByTestId('sky-view')).toBeVisible()
  await page.locator('[data-node-id="n-argo-0002"]').hover()
  await expect(page.locator('[data-node-id="n-argo-0002"]')).toHaveAttribute('data-sky-state', 'emph')
  await expect(page.locator('[data-node-id="n-argo-0001"]')).toHaveAttribute('data-sky-state', 'emph')
  await expect(page.locator('[data-node-id="n-hello-0001"]')).toHaveAttribute('data-sky-state', 'dim')
  // Off the stars, the field lets go and the mirror clears with it.
  const box = (await page.getByTestId('brain-graph').boundingBox())!
  await page.mouse.move(box.x + 6, box.y + box.height - 6)
  await expect(page.locator('[data-node-id="n-argo-0001"]')).not.toHaveAttribute('data-sky-state', /.*/)
  await expect(page.locator('[data-node-id="n-hello-0001"]')).not.toHaveAttribute('data-sky-state', /.*/)
})

test('quick-open palette (Ctrl+P) opens a note', async () => {
  await page.keyboard.press('ControlOrMeta+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('Hello')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('note-editor')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await page.keyboard.press('Escape')
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
  await page.getByTestId('palette-input').fill('Import')
  await expect(page.getByRole('option', { name: /Import/i })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(page.url()).toBe(url)
  expect((await readdir(paths.inbox)).filter((f) => f.endsWith('.md')).length).toBe(before)
})

test('list view: rows render chronologically, the filter narrows them, a row opens the note sheet', async () => {
  await openActivity(page, 'list')
  await expect(page.getByTestId('list-view')).toBeVisible()
  // the seeded living notes show up as rows
  await expect.poll(() => page.getByTestId('list-row').count()).toBeGreaterThan(1)
  const before = await page.getByTestId('list-row').count()
  const dates = await page.locator('.list-date').allTextContents()
  expect(dates.length).toBeGreaterThan(1)
  expect([...dates].sort().reverse()).toEqual(dates)
  // a pinned anchor renders when it happened, not when it was last touched
  await expect(
    page.getByTestId('list-row').filter({ hasText: 'Kickoff' }).locator('.list-date'),
  ).toHaveText('2026-02-01')
  // filtering by a unique title stem shrinks the list to the one matching row
  await page.getByTestId('list-filter').fill('Hello')
  await expect.poll(() => page.getByTestId('list-row').count()).toBeLessThan(before)
  await expect(page.getByTestId('list-row')).toHaveCount(1)
  // clicking the row opens the shared note sheet
  await page.getByTestId('list-row').first().click()
  await expect(page.getByTestId('note-sheet')).toBeVisible()
  await expect(page.getByTestId('cm-host')).toContainText('The very first note')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('note-sheet')).toHaveCount(0)
})

test('approving the seeded supersede card (A key) flips frontmatter', async () => {
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await expect(page.getByTestId('palette-input')).toBeVisible()
  await page.getByTestId('palette-input').fill('Open review')
  await expect(page.locator('[cmdk-item][data-selected="true"]')).toContainText('Open review')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('review-sheet')).toBeVisible()
  await expect(page.getByTestId('review-detail')).toBeVisible()
  await expect(page.getByTestId('diff-view')).toBeVisible()
  await page.keyboard.press('a')
  await expect
    .poll(async () => (await frontOf('n-rule-0001'))?.['status'] ?? 'pending', { timeout: 20_000 })
    .toBe('superseded')
  // The replacement note exists and points back at the old one.
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
