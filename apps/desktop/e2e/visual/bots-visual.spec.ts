import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from '../navigation.js'
import { visualDir, writeReviewSheet } from './review-sheet.js'
import { seedVisualVault } from './seed.js'
import { measureChat, serializeMetrics } from './spec.js'

const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const TMP = join(REPO, 'tmp')
const OUT = visualDir(REPO)
const THEMES = ['light', 'dark'] as const
type Theme = typeof THEMES[number]

async function launch(theme: Theme): Promise<{ app: ElectronApplication; chatId: string; dirs: string[] }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'visual-vault-')), profile = await mkdtemp(join(TMP, 'visual-profile-'))
  const { chatId } = await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  return { app, chatId, dirs: [vault, profile] }
}

async function prepare(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('bots-new')).toBeEnabled()
  return page
}

test.describe('visual', () => {
  test.skip(process.env['ENGRAM_VISUAL'] !== '1', 'Opt-in visual harness: set ENGRAM_VISUAL=1')
  test.afterAll(async () => { await writeReviewSheet(REPO) })

  test('chat', async () => {
    await mkdir(OUT, { recursive: true })
    for (const theme of THEMES) for (const ext of ['png', 'metrics.json']) await rm(join(OUT, `chat-${theme}.${ext}`), { force: true })
    for (const theme of THEMES) {
      const { app, chatId, dirs } = await launch(theme)
      try {
        const page = await prepare(app)
        const row = page.getByTestId(`bot-${chatId}`)
        const earlier = page.getByTestId('sidebar-earlier')
        if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
        await row.click()
        await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user').first()).toBeVisible()
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        const rows = await measureChat(page)
        await page.screenshot({ path: join(OUT, `chat-${theme}.png`), caret: 'hide', animations: 'disabled', scale: 'css' })
        await writeFile(join(OUT, `chat-${theme}.metrics.json`), serializeMetrics(rows))
      } finally {
        await closeTestApp(app)
        for (const dir of dirs) await rm(dir, { recursive: true, force: true })
      }
    }
  })

  for (const state of ['sidebar-states', 'info-overview', 'info-routines', 'info-past', 'create-dialog', 'empty-bot', 'toast', 'settings-review', 'onboarding-bot', 'avatar-gallery', 'avatar-picker'] as const) {
    test.fixme(state, () => undefined)
  }
})
