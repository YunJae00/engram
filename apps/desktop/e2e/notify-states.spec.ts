import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { vaultPaths } from 'core'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
const dirs: string[] = []
const UNREAD = '.sidebar-status-dot[data-status="unread"]'

async function launch(theme: 'light' | 'dark'): Promise<{ app: ElectronApplication; page: Page; vault: string }> {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-notify-states-')), profile = await mkdtemp(join(TMP, 'e2e-notify-states-profile-'))
  dirs.push(vault, profile)
  await seedVisualVault(vault)
  await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme }))
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
    ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
  } })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
  if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('bots-new')).toBeEnabled()
  return { app, page, vault }
}

async function showRow(page: Page, id: string): Promise<void> {
  const row = page.getByTestId(`bot-${id}`), earlier = page.getByTestId('sidebar-earlier')
  if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
  await expect(row).toBeVisible()
}

const weight = (page: Page, id: string) => page.getByTestId(`bot-${id}`).locator('.sidebar-conversation-name').evaluate(el => getComputedStyle(el).fontWeight)

test.afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

test.describe.serial('notify states at launch', () => {
  let app: ElectronApplication | undefined
  let page: Page

  test.beforeAll(async () => { ({ app, page } = await launch('light')) })
  test.afterAll(async () => { await closeTestApp(app) })

  test('nothing is unread at launch', async () => {
    const sidebar = page.getByTestId('app-sidebar')
    await expect(page.getByTestId('bot-vis-budget')).toBeVisible()
    await expect(sidebar.locator(UNREAD)).toHaveCount(0)
    const weights = await sidebar.locator('.sidebar-conversation-name').evaluateAll(els => els.map(el => getComputedStyle(el).fontWeight))
    expect(weights.length).toBeGreaterThan(0)
    expect(weights.every(value => value === '500')).toBe(true)
  })

  test('bell-off icon is 12px and named', async () => {
    await showRow(page, 'vis-paused')
    const bell = page.getByTestId('bot-vis-paused').locator('.sidebar-bell-off')
    await expect(bell).toHaveCount(1)
    await expect(bell).toHaveAttribute('role', 'img')
    await expect(bell).toHaveAttribute('aria-label', 'Notifications: Off')
    const box = await bell.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.abs(box!.width - 12)).toBeLessThanOrEqual(1)
    expect(Math.abs(box!.height - 12)).toBeLessThanOrEqual(1)
    await expect(page.getByTestId('bot-vis-budget').locator('.sidebar-bell-off')).toHaveCount(0)
  })
})

test('unread after a new answer elsewhere, cleared on open', async () => {
  test.setTimeout(240_000)
  for (const theme of ['light', 'dark'] as const) {
    const { app, page, vault } = await launch(theme)
    try {
      await expect(page.getByTestId('bot-vis-budget')).toBeVisible()
      await showRow(page, 'vis-chat')
      await page.getByTestId('bot-vis-chat').click()
      await expect(page.getByTestId('bot-vis-chat')).toHaveClass(/active/)
      const turn = { role: 'assistant', text: 'New numbers are in.', at: '2026-01-10T12:00:00.000Z' }
      await appendFile(join(vaultPaths(vault).cache, 'bot-chats', 'vis-budget.jsonl'), `${JSON.stringify(turn)}\n`)
      await app.evaluate(({ BrowserWindow }, event) => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', event)
      }, { type: 'chat:done', channel: 'bot-vis-budget', text: 'New numbers are in.' })
      const dot = page.getByTestId('bot-vis-budget').locator(UNREAD)
      await expect(dot).toHaveCount(1, { timeout: 5000 })
      const read = await dot.evaluate(el => {
        const probe = document.createElement('span')
        probe.style.background = 'var(--accent-blue)'
        document.body.append(probe)
        const blue = getComputedStyle(probe).backgroundColor
        probe.remove()
        const style = getComputedStyle(el), box = el.getBoundingClientRect()
        return { width: box.width, height: box.height, radius: style.borderRadius, background: style.backgroundColor, blue, label: el.getAttribute('aria-label'), animations: el.getAnimations().length }
      })
      expect(Math.abs(read.width - 8), theme).toBeLessThanOrEqual(1)
      expect(Math.abs(read.height - 8), theme).toBeLessThanOrEqual(1)
      expect(read.radius, theme).toBe('50%')
      expect(read.background, theme).toBe(read.blue)
      expect(read.label, theme).toBe('Unread activity')
      expect(read.animations, theme).toBe(0)
      expect(await weight(page, 'vis-budget'), theme).toBe('650')
      await expect(page.getByTestId('bot-vis-chat').locator(UNREAD)).toHaveCount(0)
      await page.getByTestId('bot-vis-budget').click()
      await expect(dot).toHaveCount(0)
      await expect.poll(() => weight(page, 'vis-budget')).toBe('500')
    } finally {
      await closeTestApp(app)
    }
  }
})
