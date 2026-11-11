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

async function launch(): Promise<{ page: Page; id: string }> {
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
  return { page, id }
}

const dialog = (page: Page) => page.locator('[role="dialog"][data-testid="bots-fresh-confirm"]')
const fresh = (page: Page) => page.locator('[data-testid="bots-view"] [data-testid="bots-fresh"]')

test.afterEach(async () => {
  while (apps.length) await closeTestApp(apps.pop())
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

test.describe('start over', () => {
  test('Cancel and Escape leave the conversation untouched', async () => {
    const { page, id } = await launch()
    const transcript = await page.evaluate(botId => window.engram.botTranscript(botId), id)
    const untouched = async () => {
      await expect(dialog(page)).toHaveCount(0)
      for (const turn of TURNS) await expect(page.getByTestId('bots-thread')).toContainText(turn.text)
      expect(await page.evaluate(botId => window.engram.botTranscript(botId), id)).toEqual(transcript)
      expect(await page.evaluate(botId => window.engram.botConversations(botId), id)).toEqual([])
    }
    await fresh(page).click()
    await expect(dialog(page)).toBeVisible()
    await dialog(page).getByTestId('bots-fresh-confirm-cancel').click()
    await untouched()
    await fresh(page).click()
    await expect(dialog(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await untouched()
  })

  test('Start over button sits at the top right of the chat and is named', async () => {
    const { page } = await launch()
    await expect(fresh(page)).toBeVisible()
    await expect(fresh(page)).toHaveAttribute('aria-label', 'New chat')
    const box = await page.evaluate(() => {
      const rect = (sel: string) => document.querySelector(`[data-testid="bots-view"] ${sel}`)!.getBoundingClientRect().toJSON() as DOMRect
      const chat = document.querySelector('[data-testid="bots-view"] .bots-chat')!
      const slot = parseFloat(getComputedStyle(chat, '::before').height)
      return { button: rect('[data-testid="bots-fresh"]'), chat: rect('.bots-chat'), pill: rect('[data-testid="bots-title-pill"]'), thread: rect('[data-testid="bots-thread"]'), slot }
    })
    expect(Math.abs(box.button.width - 36)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.button.height - 36)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.button.top - box.chat.top - 8)).toBeLessThanOrEqual(2)
    expect(Math.abs(box.chat.right - box.button.right - 16)).toBeLessThanOrEqual(2)
    const overlaps = box.button.left < box.pill.right && box.pill.left < box.button.right && box.button.top < box.pill.bottom && box.pill.top < box.button.bottom
    expect(overlaps).toBe(false)
    expect(box.slot).toBeGreaterThan(0)
    expect(Math.abs(box.thread.top - box.chat.top - box.slot)).toBeLessThanOrEqual(1)
    await fresh(page).click()
    await dialog(page).getByTestId('bots-fresh-confirm-ok').click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('bots-input')
    await expect(page.getByTestId('bots-thread')).not.toContainText(TURNS[0]!.text)
  })
})
