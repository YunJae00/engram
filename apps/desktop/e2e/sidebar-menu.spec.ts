import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const LONG = 'A very long section name that cannot fit inside the sidebar header at all'
const apps: ElectronApplication[] = []
const dirs: string[] = []

type Prepare = (cache: string) => Promise<void>
async function launch(theme: 'light' | 'dark', prepare?: Prepare): Promise<{ page: Page; cache: string }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-sidebar-menu-')), profile = await mkdtemp(join(TMP, 'e2e-sidebar-menu-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  const cache = join(vault, 'workspace', '.engram')
  await prepare?.(cache)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme, uiLanguage: 'en' }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  apps.push(app)
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('sidebar-create')).toBeEnabled()
  return { page, cache }
}

// Rows and sections carry no menu of any kind: renaming, moving, hiding and deleting are asked for in chat.
const menus = (page: Page) => page.locator('.sidebar-organize-menu, .sidebar-menu, [role="dialog"][aria-label^="Options for"]')
const row = (page: Page, id: string) => page.locator('.app-sidebar').getByTestId(`bot-${id}`)
const bot = (page: Page, id: string) => page.evaluate(async one => (await window.engram.botsList()).find(item => item.id === one), id)
const chatLayout = (page: Page) => page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat)

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('sidebar bots without a menu', () => {
  test('right-click, Shift+F10 and F2 open nothing, and the row has no options button and is not draggable', async () => {
    const { page } = await launch('light')
    const item = page.locator('.app-sidebar [role="tree"] [data-tree-item="item:vis-budget"]')
    await expect(page.locator('.app-sidebar [role="tree"] .sidebar-more')).toHaveCount(0)
    await expect(item).not.toHaveAttribute('draggable')
    await expect(row(page, 'vis-budget')).not.toHaveAttribute('draggable')
    await row(page, 'vis-budget').click({ button: 'right' })
    await expect(menus(page)).toHaveCount(0)
    await item.focus()
    for (const key of ['Shift+F10', 'ContextMenu', 'F2']) {
      await page.keyboard.press(key)
      await expect(menus(page)).toHaveCount(0)
      await expect(page.locator('.app-sidebar [role="tree"] input')).toHaveCount(0)
      await expect(item).toBeFocused()
    }
    await expect(row(page, 'vis-budget')).toHaveText(/Budget review/)
    // The one thing a row does: open its chat. No title pill or info pane comes with it.
    await row(page, 'vis-budget').click()
    await expect(row(page, 'vis-budget')).toHaveClass(/active/)
    await expect(page.getByTestId('bots-thread')).toContainText('January spending is within the plan')
    for (const id of ['bots-title-pill', 'bot-info-pane', 'avatar-picker']) await expect(page.getByTestId(id)).toHaveCount(0)
  })

  test('a long section name stays inside the sidebar and its header opens no menu, in light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const { page } = await launch(theme, cache => writeFile(join(cache, 'sidebar-layout.json'), JSON.stringify({
        chat: { folders: [{ id: 'vis-folder-home', name: 'Home' }, { id: 'vis-folder-long', name: LONG }], items: [{ id: 'vis-chat', folder: 'vis-folder-home' }] },
        routine: { folders: [], items: [] },
      })))
      const folder = page.getByTestId('sidebar-folder-vis-folder-long')
      await expect(folder).toHaveAttribute('aria-label', LONG)
      const geometry = await folder.evaluate(box => {
        const rect = box.getBoundingClientRect(), side = box.closest('.app-sidebar')!
        const name = box.querySelector<HTMLElement>('.sidebar-folder-head .sidebar-item-main > span')!
        return {
          inside: rect.left >= side.getBoundingClientRect().left && rect.right <= side.getBoundingClientRect().right && side.scrollWidth <= side.clientWidth,
          clipped: name.scrollWidth > name.clientWidth, overflow: getComputedStyle(name).textOverflow,
        }
      })
      expect(geometry).toEqual({ inside: true, clipped: true, overflow: 'ellipsis' })
      await folder.locator(':scope > .sidebar-folder-head').click({ button: 'right' })
      await expect(menus(page)).toHaveCount(0)
      await row(page, 'vis-budget').click({ button: 'right' })
      await expect(menus(page)).toHaveCount(0)
      await closeTestApp(apps.pop())
    }
  })

  test('hide and show round-trip through bots:update, and a hidden bot opens from its group', async () => {
    const { page } = await launch('light')
    await page.evaluate(() => window.engram.botUpdate('vis-budget', { hidden: true }))
    await expect.poll(async () => (await bot(page, 'vis-budget'))?.hidden).toBe(true)
    const group = page.locator('.sidebar-hidden-group')
    await expect(group.locator('.sidebar-folder-head')).toHaveText('Hidden bots (2)')
    await expect(group.getByTestId('bot-vis-budget')).toHaveCount(0)
    await group.locator('.sidebar-folder-head button').click()
    await expect(group.getByTestId('bot-vis-budget')).toBeVisible()
    await group.getByTestId('bot-vis-budget').click({ button: 'right' })
    await expect(menus(page)).toHaveCount(0)
    await group.getByTestId('bot-vis-budget').click()
    await expect(group.getByTestId('bot-vis-budget')).toHaveClass(/active/)
    await expect(page.getByTestId('bots-thread')).toContainText('January spending is within the plan')
    // Core clears hidden only on an own undefined; hidden: false is rejected.
    await page.evaluate(() => window.engram.botUpdate('vis-budget', { hidden: undefined }))
    await expect.poll(async () => { const one = await bot(page, 'vis-budget'); return one && Object.hasOwn(one, 'hidden') }).toBe(false)
    await expect(group.getByTestId('bot-vis-budget')).toHaveCount(0)
    await expect(group.locator('.sidebar-folder-head')).toHaveText('Hidden bots (1)')
    const shown = page.locator('.app-sidebar [role="tree"]').getByTestId('bot-vis-budget')
    await expect(shown).toBeVisible()
    expect((await shown.boundingBox())!.y).toBeLessThan((await group.boundingBox())!.y)
  })

  test('a bot moved to a new section through the app is listed under it, and no row offers a new section', async () => {
    const { page } = await launch('light')
    const before = await chatLayout(page)
    await page.evaluate(async () => {
      const layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Section N' } })
      const id = layout.chat.folders.find(folder => folder.name === 'Section N')!.id
      await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id: 'vis-new', folder: id } })
    })
    const after = await chatLayout(page)
    const added = after.folders.filter(folder => !before.folders.some(old => old.id === folder.id))
    expect(added.map(folder => folder.name)).toEqual(['Section N'])
    expect(after.items.find(item => item.id === 'vis-new')?.folder).toBe(added[0]!.id)
    await expect(page.getByTestId(`sidebar-folder-${added[0]!.id}`).getByTestId('bot-vis-new')).toBeVisible()
    await row(page, 'vis-new').click({ button: 'right' })
    await expect(menus(page)).toHaveCount(0)
    await expect(page.getByTestId('sidebar-chat-folder-name')).toHaveCount(0)
    expect(await chatLayout(page)).toEqual(after)
  })

  test('the delete summary counts routines, facts and archived chats; deleting through the app removes the row and keeps archives', async () => {
    let archive = ''
    const { page } = await launch('light', async cache => {
      const fact = (id: string) => ({ id, text: `fact ${id}`, at: '2026-01-02T00:00:00.000Z', touchedAt: '2026-01-02T00:00:00.000Z' })
      await mkdir(join(cache, 'bot-memory'), { recursive: true })
      await writeFile(join(cache, 'bot-memory', 'vis-new.json'), JSON.stringify({ facts: [fact('f1'), fact('f2')], turns: 2 }))
      archive = join(cache, 'bot-chats', 'vis-new.2026-01-02T03-04-05.jsonl')
      await writeFile(archive, `${JSON.stringify({ role: 'user', text: 'old', at: '2026-01-02T03:04:05.000Z' })}\n`)
    })
    await page.evaluate(() => window.engram.botTaskAdd('vis-new', { name: 'Daily check', goal: 'Check in.', schedule: { days: [1], hour: 9, minute: 0 } }))
    await row(page, 'vis-new').click({ button: 'right' })
    await expect(menus(page)).toHaveCount(0)
    await expect(page.locator('dialog.delete-conversation-dialog')).toHaveCount(0)
    expect(await page.evaluate(() => window.engram.botDeleteSummary('vis-new'))).toEqual({ routines: 1, facts: 2, archivedChats: 1 })
    await expect(row(page, 'vis-new')).toBeVisible()
    await page.evaluate(() => window.engram.botDelete('vis-new'))
    await expect.poll(async () => await bot(page, 'vis-new')).toBeUndefined()
    await expect(page.getByTestId('bot-vis-new')).toHaveCount(0)
    await access(archive)
  })
})
