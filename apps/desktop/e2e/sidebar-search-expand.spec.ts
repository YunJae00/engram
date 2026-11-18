import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vaultPaths } from 'core'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
let app: ElectronApplication
let page: Page
const dirs: string[] = []

const toggle = () => page.getByTestId('sidebar-search-toggle')
const rows = () => page.locator('.sidebar-conversations .bots-row')
const sidebar = () => page.getByTestId('app-sidebar')
async function expectNoSearch(): Promise<void> {
  await expect(toggle()).toHaveCount(0)
  await expect(sidebar().locator('.sidebar-search, input, textarea')).toHaveCount(0)
}

async function showSidebar(): Promise<void> {
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'false')
}

test.describe.serial('sidebar without search', () => {
  test.beforeAll(async () => {
    await mkdir(TMP, { recursive: true })
    const vault = await mkdtemp(join(TMP, 'e2e-search-expand-')), profile = await mkdtemp(join(TMP, 'e2e-search-expand-profile-'))
    dirs.push(vault, profile)
    await seedVisualVault(vault)
    const file = join(vaultPaths(vault).cache, 'bots.json')
    const stored = JSON.parse(await readFile(file, 'utf8')) as { bots: { id: string; label?: string }[] }
    stored.bots.find(bot => bot.id === 'vis-budget')!.label = 'Zqledger'
    await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light' }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(page.getByTestId('shell')).toBeVisible()
  })

  test.afterAll(async () => {
    await closeTestApp(app)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test('there is no search icon or field; the bots search used to find are listed and open with one click', async () => {
    await showSidebar()
    await expectNoSearch()
    await expect(page.getByTestId('sidebar-create')).toBeVisible()
    expect(await page.evaluate(async () => (await window.engram.botsList()).find(bot => bot.id === 'vis-budget')?.label)).toBe('Zqledger')
    expect((await page.evaluate(q => window.engram.botsSearch(q), 'spring planting')).map(hit => hit.id)).toEqual(['vis-chat'])
    const listed = await rows().count()
    for (const id of ['vis-budget', 'vis-chat']) {
      await page.getByTestId(`bot-${id}`).click()
      await expect(page.getByTestId(`bot-${id}`)).toHaveClass(/active/)
      await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
      await expect(rows()).toHaveCount(listed)
    }
    await page.getByTestId('sidebar-create').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('create-bot-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('create-bot-dialog')).toHaveCount(0)
    await expectNoSearch()
  })

  test('with no field to collapse, Esc keeps the wide sidebar, ignores IME composition, and closes the narrow overlay in one press', async () => {
    const listed = await rows().count()
    await page.getByTestId('sidebar-create').focus()
    await page.keyboard.press('Escape')
    await expect(sidebar()).toHaveAttribute('aria-hidden', 'false')
    await expect(rows()).toHaveCount(listed)
    await page.setViewportSize({ width: 780, height: 720 })
    await showSidebar()
    await expectNoSearch()
    await page.getByTestId('sidebar-create').focus()
    await page.getByTestId('sidebar-create').evaluate(button => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
      const legacy = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      Object.defineProperty(legacy, 'keyCode', { value: 229 })
      button.dispatchEvent(legacy)
    })
    await expect(sidebar()).toHaveAttribute('aria-hidden', 'false')
    await page.keyboard.press('Escape')
    await expect(sidebar()).toHaveAttribute('aria-hidden', 'true')
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  test('under reduced motion the sidebar still has no search, and routines added through the app open no library', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await showSidebar()
    await expectNoSearch()
    const routine = await page.evaluate(() => window.engram.routineAdd({ name: 'Zqportal sweep', steps: [{ kind: 'read' }] }))
    await page.evaluate(() => window.engram.routineAdd({ name: 'Other errand', steps: [{ kind: 'read' }] }))
    expect((await page.evaluate(() => window.engram.routinesList())).map(one => one.name)).toEqual(expect.arrayContaining(['Zqportal sweep', 'Other errand']))
    await expect(page.locator('.sidebar-library-title')).toHaveCount(0)
    await expect(page.getByTestId(`sidebar-routine-run-${routine.id}`)).toHaveCount(0)
    await expect(page.locator('[data-testid^="sidebar-routine"], [data-testid="routines-view"]')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-chat-collection')).toBeVisible()
    await expect(page.getByTestId('sidebar-create')).toBeVisible()
    await expectNoSearch()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  test('the sidebar has no notifications bell; at rest the footer keeps only settings', async () => {
    await showSidebar()
    await expect(page.locator('.app-sidebar [data-testid="notices-bell"]')).toHaveCount(0)
    await expect(page.locator('.sidebar-footer > .sidebar-status-block')).toHaveCount(0)
    await expect(page.locator('.sidebar-footer > *')).toHaveCount(1)
    await expect(page.locator('.sidebar-footer [data-testid="activity-settings"]')).toBeVisible()
  })
})
