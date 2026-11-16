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
async function nameFolder(name: string): Promise<string> {
  const before = new Set((await folders()).map(folder => folder.id))
  const input = page.getByTestId('sidebar-chat-folder-name')
  await expect(input).toBeFocused()
  await input.fill(name)
  await input.press('Enter')
  await expect.poll(async () => (await folders()).filter(folder => !before.has(folder.id)).map(folder => folder.name)).toEqual([name])
  return (await folders()).find(folder => !before.has(folder.id))!.id
}

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

test('one press on + creates and opens a new bot chat, and an empty one is reused', async () => {
  const before = await botList()
  await plus().click()
  await expect.poll(async () => (await botList()).length).toBe(before.length + 1)
  const created = (await botList()).find(bot => !before.some(old => old.id === bot.id))!
  expect(created.name).toBe('New bot')
  await expect(page.getByTestId(`bot-${created.id}`)).toHaveClass(/\bactive\b/)
  await expect(composer()).toBeFocused()
  await expect(page.locator('.sidebar-create-menu')).toHaveCount(0)
  await expect(page.locator(':popover-open')).toHaveCount(0)
  await expect(page.getByTestId('create-bot-dialog')).toHaveCount(0)

  await plus().click()
  await plus().dblclick()
  await expect(composer()).toBeFocused()
  await expect(page.getByTestId(`bot-${created.id}`)).toHaveClass(/\bactive\b/)
  expect((await botList()).length).toBe(before.length + 1)

  await page.evaluate(id => window.engram.botRename(id, 'Kept'), created.id)
  await expect(page.getByTestId(`bot-${created.id}`)).toContainText('Kept')
  await plus().click()
  await expect.poll(async () => (await botList()).length).toBe(before.length + 2)
  await expect(composer()).toBeFocused()
})

test('rapid presses from a non-empty bot create exactly one bot', async () => {
  const before = (await botList()).length
  await page.getByTestId('bot-vis-budget').click()
  await plus().dblclick()
  await plus().click()
  await expect(composer()).toBeFocused()
  await expect.poll(async () => (await botList()).length).toBe(before + 1)
  await page.waitForTimeout(400)
  expect((await botList()).length).toBe(before + 1)
})

test('folders are created from the header action and the right-click menu, and a bot moves into one', async () => {
  const action = page.getByTestId('sidebar-new-folder')
  await expect(action).toHaveAttribute('aria-label', 'New section')
  await action.focus()
  await page.keyboard.press('Enter')
  const plusFolder = await nameFolder('Plus folder')

  await rightClickSpace()
  const item = page.getByTestId('sidebar-space-new-folder')
  await expect(item).toBeFocused()
  await expect(item).toHaveText('New folder')
  await page.keyboard.press('Escape')
  await expect(item).toHaveCount(0)
  await rightClickSpace()
  await item.click()
  await expect(item).toHaveCount(0)
  await nameFolder('Menu folder')

  await page.locator('button[aria-label="Options for New helper"]').click()
  await page.locator('[role="dialog"][aria-label="Options for New helper"]').getByRole('button', { name: 'Move to Plus folder' }).click()
  await expect.poll(() => page.evaluate(async () => (await window.engram.sidebarLayout('chat')).chat.items.find(one => one.id === 'vis-new')?.folder)).toBe(plusFolder)
  await expect(page.getByTestId(`sidebar-folder-${plusFolder}`).getByTestId('bot-vis-new')).toBeVisible()
  expect(await page.getByTestId('create-bot-dialog').count()).toBe(0)
})

test('a failed create shows the sidebar error line', async () => {
  const before = (await botList()).length
  await app!.evaluate(({ ipcMain }) => { ipcMain.removeHandler('bots:create'); ipcMain.handle('bots:create', () => { throw new Error('no') }) })
  await page.getByTestId('bot-vis-budget').click()
  await plus().click()
  await expect(page.locator('.app-sidebar [role="alert"]')).toHaveText('Could not create the bot.')
  expect((await botList()).length).toBe(before)
  await expect(page.getByTestId('bot-vis-budget')).toHaveClass(/\bactive\b/)
})
