import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
let app: ElectronApplication | undefined
let page: Page
const dirs: string[] = []

const botList = () => page.evaluate(() => window.engram.botsList())
const folders = () => page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat.folders)
const composer = () => page.locator('[data-testid="bots-view"] [data-testid="bots-input"]')
const plus = () => page.getByTestId('sidebar-create')
async function rightClickSpace(): Promise<void> {
  const scroll = page.locator('.sidebar-scroll')
  expect(await scroll.evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true)
  const box = (await scroll.boundingBox())!
  await scroll.click({ button: 'right', position: { x: 20, y: box.height - 6 } })
}
const menus = () => page.locator('.sidebar-organize-menu, .sidebar-menu, [role="dialog"][aria-label^="Options for"]')

test.beforeEach(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-sidebar-plus-')), profile = await mkdtemp(join(TMP, 'e2e-sidebar-plus-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(plus()).toBeEnabled()
})

test.afterEach(async () => {
  await closeTestApp(app); app = undefined
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const dialog = () => page.getByTestId('create-bot-dialog')

test('+ asks for a name and icon, then creates and opens the bot', async () => {
  const before = await botList()
  await plus().click()
  await expect(dialog()).toBeVisible()
  await expect(page.getByTestId('create-bot-name')).toBeFocused()
  await expect(page.locator('.sidebar-create-menu')).toHaveCount(0)
  expect((await botList()).length).toBe(before.length)
  await page.keyboard.press('Escape')
  await expect(dialog()).toHaveCount(0)
  expect((await botList()).length).toBe(before.length)

  await plus().click()
  await page.getByTestId('create-bot-name').fill('Kept')
  await page.getByTestId('create-bot-submit').click()
  await expect(dialog()).toHaveCount(0)
  await expect.poll(async () => (await botList()).length).toBe(before.length + 1)
  const created = (await botList()).find(bot => !before.some(old => old.id === bot.id))!
  expect(created.name).toBe('Kept')
  await expect(page.getByTestId(`bot-${created.id}`)).toHaveClass(/\bactive\b/)
  await expect(composer()).toBeFocused()

  await plus().click()
  await page.getByTestId('create-bot-name').fill('Second')
  await page.getByTestId('create-bot-name').press('Enter')
  await expect.poll(async () => (await botList()).length).toBe(before.length + 2)
  await expect(composer()).toBeFocused()
})

test('rapid presses from a non-empty bot open one dialog and create exactly one bot', async () => {
  const before = (await botList()).length
  await page.getByTestId('bot-vis-budget').click()
  await plus().dblclick()
  await expect(dialog()).toHaveCount(1)
  await page.getByTestId('create-bot-name').fill('Once')
  await page.getByTestId('create-bot-submit').dblclick()
  await expect(composer()).toBeFocused()
  await expect.poll(async () => (await botList()).length).toBe(before + 1)
  await page.waitForTimeout(400)
  expect((await botList()).length).toBe(before + 1)
})

test('right-clicking empty space or a bot opens no menu; a folder made through the app holds the bot moved into it', async () => {
  await expect(page.getByTestId('sidebar-new-folder')).toHaveCount(0)
  await expect(page.locator('.sidebar-tree-head')).toHaveCount(0)
  await rightClickSpace()
  await expect(page.getByTestId('sidebar-space-new-folder')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-chat-folder-name')).toHaveCount(0)
  await expect(menus()).toHaveCount(0)
  await page.getByTestId('bot-vis-new').click({ button: 'right' })
  await expect(menus()).toHaveCount(0)
  expect((await folders()).map(folder => folder.name)).toEqual(['Home', 'Money'])

  const plusFolder = await page.evaluate(async () => {
    const layout = await window.engram.sidebarChange({ kind: 'chat', change: { action: 'create-folder', name: 'Plus folder' } })
    const id = layout.chat.folders.find(folder => folder.name === 'Plus folder')!.id
    await window.engram.sidebarChange({ kind: 'chat', change: { action: 'move-item', id: 'vis-new', folder: id } })
    return id
  })
  expect(await page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat.items.find(one => one.id === 'vis-new')?.folder)).toBe(plusFolder)
  await expect(page.getByTestId(`sidebar-folder-${plusFolder}`).getByTestId('bot-vis-new')).toBeVisible()
  await page.getByTestId(`sidebar-folder-${plusFolder}`).getByTestId('bot-vis-new').click()
  await expect(page.getByTestId('bot-vis-new')).toHaveClass(/\bactive\b/)
  expect(await dialog().count()).toBe(0)
})

test('a failed create shows the error in the dialog', async () => {
  const before = (await botList()).length
  await app!.evaluate(({ ipcMain }) => { ipcMain.removeHandler('bots:create'); ipcMain.handle('bots:create', () => { throw new Error('no') }) })
  await page.getByTestId('bot-vis-budget').click()
  await plus().click()
  await page.getByTestId('create-bot-name').fill('Never')
  await page.getByTestId('create-bot-submit').click()
  await expect(dialog().getByRole('alert')).toHaveText('Could not create the bot.')
  expect((await botList()).length).toBe(before)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('bot-vis-budget')).toHaveClass(/\bactive\b/)
})
