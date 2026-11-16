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
  await expect(page.getByTestId('sidebar-create')).toBeEnabled()
  return page
}

// A bot's routines have no tab: opening the bot shows its chat and nothing to manage them with.
async function openBot(page: Page, botId: string): Promise<void> {
  await page.getByTestId(`bot-${botId}`).click()
  await expect(page.getByTestId('bots-view')).toBeVisible()
  await expect(page.getByTestId(`bot-${botId}`)).toHaveClass(/active/)
  for (const id of ['bots-title-pill', 'bot-info-pane', 'bot-routines']) await expect(page.getByTestId(id)).toHaveCount(0)
  await expect(page.locator('[data-testid^="bot-routine-"]')).toHaveCount(0)
}

const tasks = (page: Page, botId: string) => page.evaluate(async id => (await window.engram.botsList()).find(bot => bot.id === id)?.tasks ?? [], botId)
const taskIds = (page: Page, botId: string) => page.evaluate(async id => (await window.engram.botsList()).find(bot => bot.id === id)?.tasks?.map(task => task.id) ?? [], botId)

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('bot routines without an info pane', () => {
  test('no Routines tab; the seeded tasks keep their paused and unscheduled state', async () => {
    const page = await launch()
    await openBot(page, 'vis-paused')
    expect(await tasks(page, 'vis-paused')).toMatchObject([{ id: 'vis-paused-task', name: 'Morning digest', paused: true }])
    await openBot(page, 'vis-routine')
    const [task] = await tasks(page, 'vis-routine')
    expect(task).toMatchObject({ id: 'vis-task', name: 'Friday report' })
    expect(task?.schedule).toBeUndefined()
  })

  test('A scheduled task is stored on its bot, with no routines row for it', async () => {
    const page = await launch()
    const schedule = { days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 }
    await page.evaluate(schedule => window.engram.botTaskAdd('vis-new', { name: 'Daily check', goal: 'Check the list.', schedule }), schedule)
    await openBot(page, 'vis-new')
    expect(await tasks(page, 'vis-new')).toMatchObject([{ name: 'Daily check', goal: 'Check the list.', schedule }])
  })

  test('Removing a task through the app takes it off the bot and keeps the bot', async () => {
    const page = await launch()
    await openBot(page, 'vis-routine')
    expect(await taskIds(page, 'vis-routine')).toContain('vis-task')
    await page.evaluate(() => window.engram.botTaskRemove('vis-routine', 'vis-task'))
    await expect.poll(() => taskIds(page, 'vis-routine')).not.toContain('vis-task')
    await expect(page.getByTestId('bot-vis-routine')).toBeVisible()
  })

  test('Pause stores paused, Resume removes it, and the last run time is kept', async () => {
    const page = await launch()
    await openBot(page, 'vis-routine')
    const task = () => page.evaluate(async () => (await window.engram.botsList()).find(bot => bot.id === 'vis-routine')?.tasks?.find(t => t.id === 'vis-task'))
    await page.evaluate(() => window.engram.botTaskPause('vis-routine', 'vis-task', true))
    await expect.poll(async () => { const t = await task(); return [(t as { paused?: unknown } | undefined)?.paused, t?.lastRunAt] }).toEqual([true, '2026-01-09T17:00:00.000Z'])
    await page.evaluate(() => window.engram.botTaskPause('vis-routine', 'vis-task', false))
    await expect.poll(async () => { const t = await task(); return [Object.hasOwn(t ?? {}, 'paused'), t?.lastRunAt] }).toEqual([false, '2026-01-09T17:00:00.000Z'])
    await expect(page.locator('[data-testid^="bot-routine-"]')).toHaveCount(0)
  })
})
