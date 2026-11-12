import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const apps: ElectronApplication[] = []
const dirs: string[] = []

async function launch(): Promise<Page> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-bot-routines-')), profile = await mkdtemp(join(TMP, 'e2e-bot-routines-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ uiLanguage: 'en' }))
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
  return page
}

async function openRoutines(page: Page, botId: string) {
  const row = page.getByTestId(`bot-${botId}`)
  const earlier = page.getByTestId('sidebar-earlier')
  if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
  await row.click()
  await expect(page.getByTestId('bots-view')).toBeVisible()
  if (!await page.getByTestId('bot-info-pane').isVisible()) await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()
  await expect(page.getByTestId('bot-info-pane')).toBeVisible()
  const tab = page.getByTestId('bot-info-pane').getByTestId('bot-routines')
  await expect(tab).toBeVisible()
  return tab
}

const taskIds = (page: Page, botId: string) => page.evaluate(async id => (await window.engram.botsList()).find(bot => bot.id === id)?.tasks?.map(task => task.id) ?? [], botId)

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('bot routines in the info pane', () => {
  test('Routines tab lists the seeded tasks with paused and unscheduled lines', async () => {
    const page = await launch()
    let tab = await openRoutines(page, 'vis-paused')
    const paused = tab.getByTestId('bot-routine-vis-paused-task')
    await expect(paused.getByTestId('bot-routine-paused')).toHaveText('Paused')
    await expect(paused.getByRole('button', { name: 'Test' })).toHaveCount(0)
    await expect(paused.getByRole('button', { name: 'Edit' })).toHaveCount(0)
    tab = await openRoutines(page, 'vis-routine')
    await expect(tab.getByTestId('bot-routine-vis-task')).toContainText('No run scheduled')
  })

  test('A scheduled task shows its next run, Test and Edit', async () => {
    const page = await launch()
    await page.evaluate(() => window.engram.botTaskAdd('vis-new', { name: 'Daily check', goal: 'Check the list.', schedule: { days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 } }))
    const tab = await openRoutines(page, 'vis-new')
    const row = tab.locator('li', { hasText: 'Daily check' })
    await expect(row.locator('span').first()).toHaveText(/^Next run /)
    await expect(row.getByRole('button', { name: 'Test' })).toBeVisible()
    await expect(row.getByRole('button', { name: 'Edit' })).toBeVisible()
  })

  test('Delete asks for a second press, then removes the task', async () => {
    const page = await launch()
    const tab = await openRoutines(page, 'vis-routine')
    const row = tab.getByTestId('bot-routine-vis-task')
    await row.getByRole('button', { name: 'Delete' }).click()
    await expect(row.getByRole('button', { name: 'Press again to delete' })).toBeVisible()
    expect(await taskIds(page, 'vis-routine')).toContain('vis-task')
    await row.getByRole('button', { name: 'Press again to delete' }).click()
    await expect.poll(() => taskIds(page, 'vis-routine')).not.toContain('vis-task')
    await expect(row).toHaveCount(0)
  })

  test('Pause stores paused, Resume removes it, and the row follows', async () => {
    const page = await launch()
    const tab = await openRoutines(page, 'vis-routine')
    const row = tab.getByTestId('bot-routine-vis-task')
    const button = row.getByTestId('bot-routine-pause-vis-task')
    const task = () => page.evaluate(async () => (await window.engram.botsList()).find(bot => bot.id === 'vis-routine')?.tasks?.find(t => t.id === 'vis-task'))
    await expect(button).toHaveText('Pause')
    await button.click()
    await expect.poll(async () => { const t = await task(); return [(t as { paused?: unknown } | undefined)?.paused, t?.lastRunAt] }).toEqual([true, '2026-01-09T17:00:00.000Z'])
    await expect(row.getByTestId('bot-routine-paused')).toHaveText('Paused')
    await expect(button).toHaveText('Resume')
    await button.click()
    await expect.poll(async () => { const t = await task(); return [Object.hasOwn(t ?? {}, 'paused'), t?.lastRunAt] }).toEqual([false, '2026-01-09T17:00:00.000Z'])
    await expect(button).toHaveText('Pause')
    await expect(row.getByTestId('bot-routine-paused')).toHaveCount(0)
  })
})
