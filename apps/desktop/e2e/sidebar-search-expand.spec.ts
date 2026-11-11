import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vaultPaths } from 'core'
import { closeTestApp, openActivity } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
let app: ElectronApplication
let page: Page
const dirs: string[] = []

const toggle = () => page.getByTestId('sidebar-search-toggle')
const field = () => page.getByRole('textbox', { name: 'Search conversations', exact: true })
const rows = () => page.locator('.sidebar-conversations .bots-row')
const duration = () => page.locator('.sidebar-library-tools .sidebar-search').evaluate(node => getComputedStyle(node).transitionDuration)

async function showSidebar(): Promise<void> {
  if (await page.getByTestId('app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'false')
}

async function collapsed(name = 'Search conversations'): Promise<void> {
  await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(0)
}

test.describe.serial('sidebar search expands in place', () => {
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

  test('search starts as an icon and expands into a focused field from mouse and keyboard', async () => {
    await showSidebar()
    await collapsed()
    await expect(toggle()).toBeVisible()
    await expect(toggle()).toHaveAttribute('aria-label', 'Search')
    const controls = await toggle().getAttribute('aria-controls')
    expect(await page.locator(`[id="${controls}"]`).evaluate(node => node.classList.contains('sidebar-search'))).toBe(true)
    await expect(page.getByTestId('sidebar-create')).toBeVisible()
    await toggle().click()
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await expect(field()).toBeFocused()
    await expect(page.getByTestId('sidebar-create')).toBeVisible()
    expect(await duration()).not.toBe('0s')
    await expect.poll(async () => (await field().boundingBox())?.width ?? 0).toBeGreaterThan(80)
    for (const [query, id] of [['zqledger', 'vis-budget'], ['spring garden', 'vis-chat'], ['Garden planner', 'vis-chat']] as const) {
      await toggle().click()
      await field().fill(query)
      await expect(rows()).toHaveCount(1)
      await expect(page.getByTestId(`bot-${id}`)).toBeVisible()
      await page.getByTestId(`bot-${id}`).click()
      await expect(page.getByTestId(`bot-${id}`)).toHaveClass(/active/)
      await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
      await toggle().click()
      await page.getByRole('button', { name: 'Clear search', exact: true }).click()
      await expect(field()).toBeFocused()
    }
    await field().press('Escape')
    await collapsed()
    await expect(toggle()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(field()).toBeFocused()
    await page.keyboard.press('Escape')
    await collapsed()
    await page.getByTestId('sidebar-create').focus()
    await page.keyboard.press('Shift+Tab')
    await expect(toggle()).toBeFocused()
    await page.keyboard.press('Space')
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await expect(field()).toBeFocused()
    await page.keyboard.press('Escape')
    await collapsed()
  })

  test('Esc and blur collapse the field without hiding an active filter', async () => {
    await toggle().click()
    await field().fill('zzz-no-such-bot')
    await field().press('Escape')
    await expect(field()).toHaveValue('')
    await expect(field()).toBeFocused()
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await collapsed()
    await expect(toggle()).toBeFocused()
    await toggle().click()
    await page.getByTestId('sidebar-create').focus()
    await collapsed()
    await toggle().click()
    await field().fill('Garden planner')
    await page.getByRole('button', { name: 'Clear search', exact: true }).focus()
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Shift+Tab')
    await expect(field()).toBeFocused()
    await page.getByTestId('sidebar-create').focus()
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await expect(field()).toHaveValue('Garden planner')
    await expect(rows()).toHaveCount(1)
    await field().evaluate(input => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
      const legacy = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      Object.defineProperty(legacy, 'keyCode', { value: 229 })
      input.dispatchEvent(legacy)
    })
    await expect(field()).toHaveValue('Garden planner')
    await toggle().click()
    await page.getByRole('button', { name: 'Clear search', exact: true }).click()
    await field().evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    })
    await page.getByTestId('sidebar-create').focus()
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    await field().evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    await field().focus()
    await page.keyboard.press('Escape')
    await collapsed()
    await page.setViewportSize({ width: 780, height: 720 })
    await showSidebar()
    await toggle().click()
    await expect(field()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(toggle()).toBeFocused()
    await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'false')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('app-sidebar')).toHaveAttribute('aria-hidden', 'true')
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  test('reduced motion expands instantly and the routines library behaves the same', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await showSidebar()
    expect(await duration()).toBe('0s')
    await toggle().click()
    await expect(field()).toBeFocused()
    await expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(await duration()).toBe('0s')
    await field().fill('Garden')
    const routine = await page.evaluate(() => window.engram.routineAdd({ name: 'Zqportal sweep', steps: [{ kind: 'read' }] }))
    await page.evaluate(() => window.engram.routineAdd({ name: 'Other errand', steps: [{ kind: 'read' }] }))
    await openActivity(page, 'routines')
    await showSidebar()
    await expect(page.locator('.sidebar-library-title')).toBeVisible()
    await collapsed('Search routines')
    await expect(toggle()).toHaveAttribute('aria-label', 'Search')
    await expect(page.getByTestId('sidebar-create')).toBeVisible()
    await toggle().click()
    const routineField = page.getByRole('textbox', { name: 'Search routines', exact: true })
    await expect(routineField).toBeFocused()
    await expect(page.getByTestId('sidebar-create')).toBeVisible()
    await routineField.fill('zqportal')
    await expect(page.getByTestId(`sidebar-routine-run-${routine.id}`)).toBeVisible()
    await expect(page.locator('.sidebar-conversations .sidebar-item')).toHaveCount(1)
    await page.getByRole('button', { name: 'Conversations', exact: true }).click()
    await expect(page.locator('.sidebar-library-title')).toHaveCount(0)
    await collapsed()
    await expect(page.getByTestId('sidebar-create')).toBeVisible()
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  })

  test('the notices inbox opens from the sidebar footer, not the header', async () => {
    await showSidebar()
    await expect(page.locator('.sidebar-footer [data-testid="notices-bell"]')).toHaveCount(1)
    await expect(page.locator('.sidebar-library-tools [data-testid="notices-bell"], .app-sidebar-head [data-testid="notices-bell"]')).toHaveCount(0)
    const bell = page.getByTestId('notices-bell')
    await expect(bell).toHaveAttribute('aria-label', 'Notifications')
    for (const size of [{ width: 1280, height: 800 }, { width: 780, height: 720 }]) {
      await page.setViewportSize(size)
      await showSidebar()
      await bell.click()
      const panel = page.getByTestId('notices-panel')
      await expect(panel).toBeVisible()
      const [box, button] = [await panel.boundingBox(), await bell.boundingBox()]
      expect(box!.y + box!.height).toBeLessThanOrEqual(button!.y)
      expect(box!.y).toBeGreaterThanOrEqual(0)
      expect(box!.x).toBeGreaterThanOrEqual(8)
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width - 8)
      await page.keyboard.press('Escape')
      await expect(panel).toBeHidden()
    }
    await page.setViewportSize({ width: 1280, height: 800 })
  })
})
