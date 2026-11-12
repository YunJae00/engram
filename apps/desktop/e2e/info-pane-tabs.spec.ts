import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')

test('the info pane is one panel with no tabs', async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-info-pane-')), profile = await mkdtemp(join(TMP, 'e2e-info-pane-profile-'))
  let app: ElectronApplication | undefined
  try {
    await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()

    const pane = page.getByTestId('bot-info-pane')
    const pill = page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]')
    const input = page.locator('[data-testid="bots-view"] [data-testid="bots-input"]')
    await page.getByTestId('bot-vis-routine').click()
    await pill.click()
    await expect(pane).toBeVisible()

    await expect(pane.locator('[role=tablist], [role=tab], [role=tabpanel]')).toHaveCount(0)
    const panel = pane.locator('.bot-info-panel')
    await expect(panel).toHaveCount(1)
    await expect(panel.getByTestId('bot-info-avatar')).toBeVisible()
    await expect(panel.locator('h2')).toHaveText('Weekly report')
    await expect(panel.locator('textarea')).toBeVisible()
    await expect(panel.getByRole('radiogroup')).toBeVisible()
    await expect(panel.getByTestId('bot-routines')).toBeVisible()
    await expect(panel.getByTestId('bot-routine-vis-task')).toBeVisible()
    for (const id of ['bot-files', 'bot-past-item', 'bot-computer', 'bot-info-empty']) await expect(pane.getByTestId(id)).toHaveCount(0)
    await expect(input).toBeVisible()

    await panel.locator('textarea').focus()
    await page.keyboard.press('Escape')
    await expect(pane).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('bots-input')

    const earlier = page.getByTestId('sidebar-earlier')
    if (!await page.getByTestId('bot-vis-new').isVisible() && await earlier.isVisible()) await earlier.click()
    await page.getByTestId('bot-vis-new').click()
    await expect(pane).toHaveCount(0)
    await pill.click()
    await expect(pane).toBeVisible()
    await expect(pane.getByTestId('bot-routines')).toHaveCount(0)
    await expect(pane.getByTestId('bot-info-empty')).toHaveCount(0)
  } finally {
    await closeTestApp(app)
    for (const dir of [vault, profile]) await rm(dir, { recursive: true, force: true })
  }
})
