import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')

test('there is no info pane, title pill or tabs: the bot shows in its sidebar row and its empty thread, and its instructions and notifications are changed by chat', async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-info-pane-')), profile = await mkdtemp(join(TMP, 'e2e-info-pane-profile-')), mock = await mkdtemp(join(TMP, 'e2e-info-pane-mock-'))
  let app: ElectronApplication | undefined
  try {
    await seedVisualVault(vault)
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
    await writeFile(join(mock, 'COMET-STEP.json'), JSON.stringify({ tool: 'teammate_settings', args: { instructions: 'Writes the Friday report by noon.', notify: 'off' } }))
    await writeFile(join(mock, 'COMET-ANSWER.md'), 'The report is due Friday noon now, and notifications are off.')
    await writeFile(join(mock, 'default.md'), 'OK.')
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'mock', ENGRAM_MOCK_DIR: mock, ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()

    const pane = page.getByTestId('bot-info-pane')
    const pill = page.getByTestId('bots-title-pill')
    const view = page.getByTestId('bots-view')
    const input = page.locator('[data-testid="bots-view"] [data-testid="bots-input"]')
    await page.getByTestId('bot-vis-routine').click()
    await expect(page.getByTestId('bots-thread')).toBeVisible()
    await expect(pill).toHaveCount(0)
    await expect(pane).toHaveCount(0)

    await expect(view.locator('[role=tablist], [role=tab], [role=tabpanel]')).toHaveCount(0)
    await expect(page.locator('.bot-info-panel')).toHaveCount(0)
    await expect(page.locator('[data-testid="bot-vis-routine"] .sidebar-conversation-name')).toHaveText('Weekly report')
    await expect(page.locator('[data-testid="bot-vis-routine"] .bot-avatar')).toBeVisible()
    for (const id of ['bot-info-avatar', 'bot-routines', 'bot-routine-vis-task', 'bot-files', 'bot-past-item', 'bot-computer', 'bot-info-empty', 'bots-memory']) await expect(page.getByTestId(id)).toHaveCount(0)
    await expect(view.getByRole('radiogroup')).toHaveCount(0)
    await expect(input).toBeVisible()

    await input.fill('From now on write the Friday report by noon, and turn your notifications off.')
    await input.press('Enter')
    await expect.poll(async () => (await page.evaluate(async () => (await window.engram.botsList()).find(bot => bot.id === 'vis-routine')))?.notify, { timeout: 60_000 }).toBe('off')
    const saved = await page.evaluate(async () => (await window.engram.botsList()).find(bot => bot.id === 'vis-routine'))
    expect(saved).toMatchObject({ purpose: 'Writes the Friday report by noon.', notify: 'off' })
    expect(saved?.tasks?.map(task => task.id)).toEqual(['vis-task'])
    await expect(page.locator('[data-testid="bot-vis-routine"] .sidebar-bell-off')).toBeVisible()
    await expect(page.getByTestId('bots-thread')).toContainText('The report is due Friday noon now, and notifications are off.', { timeout: 60_000 })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(pane).toHaveCount(0)

    await input.focus()
    await page.keyboard.press('Escape')
    await expect(pane).toHaveCount(0)
    await expect(input).toBeVisible()

    const earlier = page.getByTestId('sidebar-earlier')
    if (!await page.getByTestId('bot-vis-new').isVisible() && await earlier.isVisible()) await earlier.click()
    await page.getByTestId('bot-vis-new').click()
    await expect(pane).toHaveCount(0)
    await expect(pill).toHaveCount(0)
    const empty = page.getByTestId('bot-empty')
    await expect(empty.locator('h2')).toHaveText('New helper')
    await expect(empty.locator('.bot-avatar')).toBeVisible()
    await expect(page.getByTestId('bot-empty-chip')).toHaveCount(0)
    await expect(page.getByTestId('bot-routines')).toHaveCount(0)
    await expect(page.getByTestId('bot-info-empty')).toHaveCount(0)
  } finally {
    await closeTestApp(app)
    for (const dir of [vault, profile, mock]) await rm(dir, { recursive: true, force: true })
  }
})
