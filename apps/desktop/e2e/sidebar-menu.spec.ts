import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const LONG = 'A very long section name that cannot fit inside the row menu at all'
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
  await expect(page.getByTestId('bots-new')).toBeEnabled()
  return { page, cache }
}

const menu = (page: Page, name: string) => page.locator(`[role="dialog"][aria-label="Options for ${name}"]`)
const more = (page: Page, name: string) => page.locator(`button[aria-label="Options for ${name}"]`)
const bot = (page: Page, id: string) => page.evaluate(async one => (await window.engram.botsList()).find(item => item.id === one), id)
const chatLayout = (page: Page) => page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat)

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('sidebar bot menu', () => {
  test('menu opens from the options button, right-click and Shift+F10', async () => {
    const { page } = await launch('light')
    const dialog = menu(page, 'Budget review'), button = more(page, 'Budget review')
    await button.click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button')).toHaveText(['Rename', 'Pin', 'Move to Home', 'Move to new section', 'Hide from sidebar', 'Make primary', 'Delete'])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
    await page.getByTestId('bot-vis-budget').click({ button: 'right' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
    await page.getByTestId('bot-vis-budget').focus()
    await page.keyboard.press('Shift+F10')
    await expect(dialog).toBeVisible()
    await expect(page.locator('[role="dialog"][aria-label^="Options for"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(button).toBeFocused()
  })

  test('menu has 12px corners and 32px items in light and dark', async () => {
    for (const theme of ['light', 'dark'] as const) {
      const { page } = await launch(theme, cache => writeFile(join(cache, 'sidebar-layout.json'), JSON.stringify({
        chat: { folders: [{ id: 'vis-folder-home', name: 'Home' }, { id: 'vis-folder-long', name: LONG }], items: [{ id: 'vis-chat', folder: 'vis-folder-home' }] },
        routine: { folders: [], items: [] },
      })))
      await more(page, 'Budget review').click()
      await expect(menu(page, 'Budget review').getByRole('button', { name: `Move to ${LONG}` })).toBeVisible()
      const geometry = await menu(page, 'Budget review').evaluate((box, long) => {
        const rect = box.getBoundingClientRect()
        const items = [...box.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const overflow = items.flatMap(item => [item, ...item.querySelectorAll<HTMLElement>('*')])
          .filter(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis').map(el => el.textContent)
        return {
          radius: getComputedStyle(box).borderTopLeftRadius, heights: items.map(item => item.getBoundingClientRect().height),
          inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight, overflow,
          title: items.find(item => item.textContent?.includes(long))?.querySelector('[title]')?.getAttribute('title'),
        }
      }, LONG)
      expect(geometry.radius).toBe('12px')
      expect(geometry.heights.length).toBeGreaterThan(0)
      for (const height of geometry.heights) expect(Math.abs(height - 32)).toBeLessThanOrEqual(2)
      expect(geometry.inside).toBe(true)
      expect(geometry.overflow).toEqual([])
      expect(geometry.title).toBe(`Move to ${LONG}`)
      await closeTestApp(apps.pop())
    }
  })

  test('hide and show round-trip through bots:update', async () => {
    const { page } = await launch('light')
    await more(page, 'Budget review').click()
    await menu(page, 'Budget review').getByRole('button', { name: 'Hide from sidebar' }).click()
    await expect.poll(async () => (await bot(page, 'vis-budget'))?.hidden).toBe(true)
    const group = page.locator('.sidebar-hidden-group')
    await expect(group.locator('.sidebar-folder-head')).toHaveText('Hidden bots (2)')
    await group.locator('.sidebar-folder-head button').click()
    await expect(group.getByTestId('bot-vis-budget')).toBeVisible()
    await group.locator('button[aria-label="Options for Budget review"]').click()
    await expect(menu(page, 'Budget review').getByRole('button')).toHaveText(['Rename', 'Show', 'Make primary', 'Delete'])
    await menu(page, 'Budget review').getByRole('button', { name: 'Show' }).click()
    await expect.poll(async () => { const one = await bot(page, 'vis-budget'); return one && Object.hasOwn(one, 'hidden') }).toBe(false)
    await expect(group.getByTestId('bot-vis-budget')).toHaveCount(0)
    const row = page.locator('.app-sidebar [role="tree"]').getByTestId('bot-vis-budget')
    await expect(row).toBeVisible()
    expect((await row.boundingBox())!.y).toBeLessThan((await group.boundingBox())!.y)
  })

  test('move to new section files the bot in one new section', async () => {
    const { page } = await launch('light')
    const before = await chatLayout(page)
    await more(page, 'New helper').click()
    await menu(page, 'New helper').getByRole('button', { name: 'Move to new section' }).click()
    const input = page.getByTestId('sidebar-chat-folder-name')
    await input.fill('Section N')
    await input.press('Enter')
    await expect.poll(async () => (await chatLayout(page)).folders.length).toBe(before.folders.length + 1)
    const after = await chatLayout(page)
    const added = after.folders.filter(folder => !before.folders.some(old => old.id === folder.id))
    expect(added.map(folder => folder.name)).toEqual(['Section N'])
    expect(after.items.find(item => item.id === 'vis-new')?.folder).toBe(added[0]!.id)
    await expect(page.getByTestId(`sidebar-folder-${added[0]!.id}`).getByTestId('bot-vis-new')).toBeVisible()
    await more(page, 'New helper').click()
    await menu(page, 'New helper').getByRole('button', { name: 'Move to new section' }).click()
    await input.fill('Never made')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    expect(await chatLayout(page)).toEqual(after)
  })

  test('delete shows routine, fact and archived chat counts and keeps archives', async () => {
    let archive = ''
    const { page } = await launch('light', async cache => {
      const fact = (id: string) => ({ id, text: `fact ${id}`, at: '2026-01-02T00:00:00.000Z', touchedAt: '2026-01-02T00:00:00.000Z' })
      await mkdir(join(cache, 'bot-memory'), { recursive: true })
      await writeFile(join(cache, 'bot-memory', 'vis-new.json'), JSON.stringify({ facts: [fact('f1'), fact('f2')], turns: 2 }))
      archive = join(cache, 'bot-chats', 'vis-new.2026-01-02T03-04-05.jsonl')
      await writeFile(archive, `${JSON.stringify({ role: 'user', text: 'old', at: '2026-01-02T03:04:05.000Z' })}\n`)
    })
    await page.evaluate(() => window.engram.botTaskAdd('vis-new', { name: 'Daily check', goal: 'Check in.', schedule: { days: [1], hour: 9, minute: 0 } }))
    await more(page, 'New helper').click()
    await menu(page, 'New helper').getByRole('button', { name: 'Delete' }).click()
    const dialog = page.locator('dialog.delete-conversation-dialog')
    await expect(dialog.getByTestId('delete-summary-routines')).toHaveAttribute('data-count', '1')
    await expect(dialog.getByTestId('delete-summary-facts')).toHaveAttribute('data-count', '2')
    await expect(dialog.getByTestId('delete-summary-archived')).toHaveAttribute('data-count', '1')
    await expect(dialog).toContainText('Archived chats stay on disk.')
    await dialog.getByRole('button', { name: 'Delete conversation' }).click()
    await expect.poll(async () => await bot(page, 'vis-new')).toBeUndefined()
    await expect(page.getByTestId('bot-vis-new')).toHaveCount(0)
    await access(archive)
  })
})
