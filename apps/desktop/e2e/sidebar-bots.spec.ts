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

test.describe.serial('sidebar bots', () => {
  test.beforeAll(async () => {
    await mkdir(TMP, { recursive: true })
    const vault = await mkdtemp(join(TMP, 'e2e-sidebar-bots-')), profile = await mkdtemp(join(TMP, 'e2e-sidebar-bots-profile-'))
    dirs.push(vault, profile)
    await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light' }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect(page.getByTestId('bots-new')).toBeEnabled()
  })

  test.afterAll(async () => {
    await closeTestApp(app)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test('hero opens the primary chat and old bots are listed', async () => {
    const hero = page.locator('.sidebar-primary')
    const tree = page.locator('.app-sidebar [role="tree"]')
    await expect(hero).toBeVisible()
    await expect(hero).toContainText('Sun')
    await expect(page.locator('.sidebar-primary [data-testid="bot-vis-primary"]')).toHaveCount(1)
    await expect(tree.locator('[data-testid="bot-vis-primary"]')).toHaveCount(0)
    for (const id of ['vis-chat', 'vis-budget', 'vis-new', 'vis-routine', 'vis-paused']) await expect(tree.getByTestId(`bot-${id}`)).toBeVisible()
    await expect(page.getByTestId('bot-vis-hidden')).not.toBeVisible()
    await expect(page.getByTestId('sidebar-earlier')).toHaveCount(0)
    await page.locator('.sidebar-primary [data-testid="bot-vis-primary"]').click()
    await expect(page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]')).toContainText('Sun')
  })

  test('rows show the time only in a tooltip and the row menu still works', async () => {
    const row = page.getByTestId('bot-vis-budget')
    await expect(row.locator('time')).toHaveCount(0)
    await expect(row.locator('.sidebar-conversation-content')).toHaveAttribute('title', /2026/)
    await page.locator('button[aria-label="Options for Budget review"]').click()
    const menu = page.locator('[role="dialog"][aria-label="Options for Budget review"]')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('button')).toHaveText(['Rename', 'Pin', 'Delete'])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
})
