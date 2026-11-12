import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vaultPaths } from 'core'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const TURNS = [
  { role: 'user', text: 'zq start over question', at: '2026-11-01T09:00:00.000Z' },
  { role: 'assistant', text: 'zq start over answer', at: '2026-11-01T09:00:05.000Z' },
]
const apps: ElectronApplication[] = []
const dirs: string[] = []

async function launch(): Promise<{ page: Page }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-fresh-start-')), profile = await mkdtemp(join(TMP, 'e2e-fresh-start-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light', uiLanguage: 'en' }))
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
  const id = await page.evaluate(async () => (await window.engram.botCreate({ name: 'Fresh Spec Bot', purpose: 'Seeded start over bot' })).id)
  const chats = join(vaultPaths(vault).cache, 'bot-chats')
  await mkdir(chats, { recursive: true })
  await writeFile(join(chats, `${id}.jsonl`), TURNS.map(turn => `${JSON.stringify(turn)}\n`).join(''))
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.locator(`[data-testid="bot-${id}"]`).first().click()
  for (const turn of TURNS) await expect(page.getByTestId('bots-thread')).toContainText(turn.text)
  return { page }
}

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('start over', () => {
  test('the chat has no start-over button', async () => {
    const { page } = await launch()
    const chat = page.locator('[data-testid="bots-view"] .bots-chat')
    await expect(chat.getByTestId('bots-title-pill')).toBeVisible()
    await expect(chat.getByTestId('bots-input')).toBeVisible()
    await expect(page.getByTestId('bots-fresh')).toHaveCount(0)
    await expect(chat.getByRole('button', { name: 'New chat', exact: true })).toHaveCount(0)
    await expect(chat.locator('.lucide-message-square-plus')).toHaveCount(0)
    await expect(page.getByTestId('bots-fresh-confirm')).toHaveCount(0)
    for (const turn of TURNS) await expect(page.getByTestId('bots-thread')).toContainText(turn.text)
  })
})
