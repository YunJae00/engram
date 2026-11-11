import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vaultPaths } from 'core'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const LANE = 'bot-vis-routine'
const CLAUDE = 'Claude is controlling your computer'
const TURNS = [
  { role: 'user', text: 'Here is the sheet.', at: '2026-01-10T09:00:00.000Z', attachments: ['11111111-1111-4111-8111-111111111111-sheet.csv'] },
  { role: 'assistant', text: 'Got it.', at: '2026-01-10T09:00:05.000Z' },
]
const ARCHIVE = [
  { role: 'user', text: 'Draft last week\'s report.', at: '2026-01-08T10:00:00.000Z' },
  { role: 'assistant', text: 'Done, it is in your notes.', at: '2026-01-08T10:00:05.000Z' },
]
const ROWS = [
  { id: 't1', url: 'https://example.com/a', title: 'Example A', active: true },
  { id: 't2', url: 'https://news.example.org/x', active: false },
]
const RUNNING = { state: 'running', lane: LANE, engineLabel: 'Claude' }
const jsonl = (turns: object[]) => turns.map(turn => JSON.stringify(turn)).join('\n') + '\n'

test('all five info tabs open and show their surface, Computer seeded and empty', async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-info-tabs-')), profile = await mkdtemp(join(TMP, 'e2e-info-tabs-profile-'))
  let app: ElectronApplication | undefined
  try {
    await seedVisualVault(vault)
    const chats = join(vaultPaths(vault).cache, 'bot-chats')
    await writeFile(join(chats, 'vis-routine.jsonl'), jsonl(TURNS))
    await writeFile(join(chats, 'vis-routine.2026-01-08T10-00-00.jsonl'), jsonl(ARCHIVE))
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
    const panel = (key: string) => page.locator(`#bot-info-panel-${key}`)
    const open = async (key: string) => {
      const tab = page.locator(`#bot-info-tab-${key}`)
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(panel(key)).toBeVisible()
      await expect(pane.locator('[role=tabpanel]:visible')).toHaveCount(1)
    }
    const send = (event: object) => app!.evaluate(({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', payload)
    }, event)

    await page.getByTestId('bot-vis-routine').click()
    await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user').last()).toContainText('Here is the sheet.')
    await page.locator('[data-testid="bots-view"] [data-testid="bots-title-pill"]').click()

    await open('overview')
    await expect(panel('overview').locator('h2')).toHaveText('Weekly report')
    await expect(panel('overview').getByTestId('bot-info-empty')).toHaveCount(0)

    await open('routines')
    await expect(panel('routines').getByTestId('bot-routines')).toBeVisible()
    await expect(panel('routines').getByTestId('bot-routine-vis-task')).toBeVisible()
    await expect(panel('routines').getByTestId('bot-info-empty')).toHaveCount(0)

    await open('files')
    const files = panel('files').getByTestId('bot-files')
    await expect(files).toBeVisible()
    await expect(files.getByTestId('chat-file-card')).toContainText('sheet.csv')

    await open('past')
    await expect(panel('past').getByTestId('bot-past-item')).toHaveCount(1)
    await panel('past').getByTestId('bot-past-item').click()
    await expect(panel('past').getByTestId('bot-past-view')).toBeVisible()
    await expect(panel('past').locator('.bubble-msg')).toHaveCount(2)

    await open('computer')
    const computer = panel('computer')
    await expect(computer.getByTestId('bot-info-empty')).toBeVisible()
    await expect(computer.getByTestId('bot-info-empty')).toContainText('Nothing here yet.')
    await expect(computer.getByTestId('bot-computer')).toHaveCount(0)

    await app.evaluate(({ ipcMain }, rows) => {
      ipcMain.removeHandler('agent:tabs')
      ipcMain.handle('agent:tabs', () => rows)
    }, ROWS)
    await send({ type: 'agent:tabs', lane: LANE, tabs: ROWS })
    const rows = computer.getByTestId('bot-computer-tab')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toHaveText('Example A')
    await expect(rows.nth(0)).toHaveAttribute('data-active', 'true')
    await expect(rows.nth(1)).toHaveText('news.example.org')
    await expect(rows.nth(1)).toHaveAttribute('data-active', 'false')
    await expect(computer.locator('[data-testid="bot-computer-tabs"] h3')).toHaveText('Browser tabs')
    await expect(computer.getByTestId('bot-info-empty')).toHaveCount(0)

    await app.evaluate(({ ipcMain }, lane) => {
      const main = globalThis as unknown as { __infoTabsControl?: unknown }
      main.__infoTabsControl = { state: 'idle' }
      for (const channel of ['desktop:available', 'desktop:bindings', 'desktop:controlStatus']) ipcMain.removeHandler(channel)
      ipcMain.handle('desktop:available', () => true)
      ipcMain.handle('desktop:bindings', () => [{ lane, source: 'app', name: 'Notes', readable: true }])
      ipcMain.handle('desktop:controlStatus', () => main.__infoTabsControl ?? { state: 'idle' })
    }, LANE)
    await send({ type: 'desktop:changed' })
    await expect(computer.getByTestId('bot-computer-window')).toHaveText('Notes')
    await expect(computer.locator('[data-testid="bot-computer-desktop"] h3')).toHaveText('Desktop')

    const hand = (control: object) => app!.evaluate(({ BrowserWindow }, next) => {
      (globalThis as unknown as { __infoTabsControl?: unknown }).__infoTabsControl = next
      BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'desktop:control', control: next })
    }, control)
    const control = computer.getByTestId('bot-computer-control')
    await hand(RUNNING)
    await expect(control).toHaveText(CLAUDE)
    await page.waitForTimeout(2500)
    expect(await control.textContent()).toBe(CLAUDE)

    await hand({ state: 'running', lane: 'bot-other', engineLabel: 'Codex' })
    await expect(control).toHaveCount(0)
    await page.waitForTimeout(2500)
    expect(await control.count()).toBe(0)
    await expect(computer.getByTestId('bot-computer-window')).toHaveText('Notes')
    await expect(rows).toHaveCount(2)

    await hand(RUNNING)
    await expect(control).toHaveText(CLAUDE)
    await hand({ state: 'idle' })
    await expect(control).toHaveCount(0)
    await expect(computer.getByTestId('bot-computer-window')).toHaveText('Notes')
  } finally {
    await closeTestApp(app)
    for (const dir of [vault, profile]) await rm(dir, { recursive: true, force: true })
  }
})
