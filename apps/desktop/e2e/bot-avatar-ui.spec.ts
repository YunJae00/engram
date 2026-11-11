import { expect, test, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { addNotice, vaultPaths } from 'core'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'
import { seedVisualVault } from './visual/seed.js'

const TMP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'tmp')
let app: ElectronApplication | undefined
let page: Page
const dirs: string[] = []
const row = (id: string) => page.getByTestId(`bot-${id}`)

async function square(locator: Locator, side: number): Promise<void> {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(Math.abs(box!.width - side)).toBeLessThanOrEqual(1)
  expect(Math.abs(box!.height - side)).toBeLessThanOrEqual(1)
}

async function emit(id: string, working: boolean): Promise<void> {
  await app!.evaluate(({ BrowserWindow }, event) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', event)
  }, { type: 'comet:working', channel: `bot-${id}`, working })
}

async function showEarlier(): Promise<void> {
  const earlier = page.getByTestId('sidebar-earlier')
  if (!await row('vis-chat').isVisible() && await earlier.isVisible()) await earlier.click()
  await expect(row('vis-chat')).toBeVisible()
}

test.describe.serial('bot avatar ui', () => {
  test.beforeAll(async () => {
    await mkdir(TMP, { recursive: true })
    const vault = await mkdtemp(join(TMP, 'e2e-bot-avatar-ui-')), profile = await mkdtemp(join(TMP, 'e2e-bot-avatar-ui-profile-'))
    dirs.push(vault, profile)
    await seedVisualVault(vault)
    await addNotice(vaultPaths(vault), { kind: 'system', title: 'Garden notice', text: 'From the garden planner', botId: 'vis-chat' })
    await addNotice(vaultPaths(vault), { kind: 'system', title: 'Plain notice', text: 'No conversation' })
    await writeFile(join(profile, 'settings.json'), JSON.stringify({ theme: 'light' }))
    app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: profile,
      ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1',
    } })
    page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800) })
    if (!await page.evaluate(() => innerWidth === 1280 && innerHeight === 800)) await page.setViewportSize({ width: 1280, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.getByTestId('shell')).toBeVisible()
    await expect(page.getByTestId('bots-new')).toBeEnabled()
  })

  test.afterAll(async () => {
    await closeTestApp(app)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  test('welcome shows the primary bot at 64px', async () => {
    await page.getByTestId('sidebar-create').click()
    await page.getByTestId('bots-new').click(); await page.keyboard.press('Escape')
    const avatar = page.locator('[data-testid="comet-welcome"] .comet-welcome-mark .bot-avatar[data-size="64"][data-state="idle"]')
    await expect(avatar).toBeVisible()
    await square(avatar, 64)
    await expect(avatar.locator('.bot-avatar-primary')).toHaveCount(1)
    await expect(avatar.locator('svg')).toHaveCount(1)
    await expect(page.locator('.comet-welcome-mark [data-icon="comet-face"]')).toHaveCount(0)
  })

  test('sidebar rows show 36px avatars with the activity dot', async () => {
    await showEarlier()
    const avatar = row('vis-chat').locator('.sidebar-conversation-avatar > .bot-avatar[data-size="36"][data-state="idle"]')
    await expect(avatar).toBeVisible()
    await square(avatar, 36)
    await expect(avatar.locator('svg')).toHaveCount(1)
    await expect(row('vis-chat').locator('.bot-avatar-primary')).toHaveCount(0)
    await emit('vis-chat', true)
    await expect(row('vis-chat').locator('.sidebar-conversation-avatar > .comet-activity-icon[data-state="running"]')).toBeVisible()
    await expect(row('vis-chat').locator('.sidebar-conversation-avatar > .bot-avatar[data-state="working"]')).toBeVisible()
    await emit('vis-chat', false)
    await expect(row('vis-chat').locator('.bot-avatar')).toHaveAttribute('data-state', 'idle')
    await expect(row('vis-chat').locator('.sidebar-conversation-avatar > .comet-activity-icon')).toHaveCount(0)
    await expect(row('vis-primary').locator('.bot-avatar .bot-avatar-primary')).toBeVisible()
    await expect(page.locator('[data-testid="app-sidebar"] .comet-avatar')).toHaveCount(0)
    await expect(page.locator('[data-testid="app-sidebar"] .sidebar-conversation-avatar [data-icon="comet-face"]')).toHaveCount(0)
  })

  test('a working bot shows the working avatar', async () => {
    await emit('vis-budget', true)
    await expect(row('vis-budget').locator('.bot-avatar[data-state="working"]')).toBeVisible()
    await expect(row('vis-budget').locator('.sidebar-conversation-avatar > .comet-activity-icon[data-state="running"]')).toBeVisible()
    await expect(row('vis-chat').locator('.bot-avatar')).toHaveAttribute('data-state', 'idle')
  })

  test('the primary star badge stays clear of the activity indicator', async () => {
    const badge = row('vis-primary').locator('.bot-avatar .bot-avatar-primary')
    const indicator = row('vis-primary').locator('.sidebar-conversation-avatar > .comet-activity-icon')
    const clear = async (state: string) => {
      await expect(indicator).toHaveAttribute('data-state', state)
      await expect(badge).toBeVisible()
      const [a, b] = [await badge.boundingBox(), await indicator.boundingBox()]
      expect(a && b).toBeTruthy()
      const overlap = a!.x < b!.x + b!.width && b!.x < a!.x + a!.width && a!.y < b!.y + b!.height && b!.y < a!.y + a!.height
      expect(overlap, `${state}: badge ${JSON.stringify(a)} indicator ${JSON.stringify(b)}`).toBe(false)
      const hit = await badge.evaluate((el) => {
        const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return !!top && (el === top || el.contains(top))
      })
      expect(hit, `${state}: badge centre is covered`).toBe(true)
    }
    await emit('vis-primary', true)
    await clear('running')
    await app!.evaluate(({ BrowserWindow }, event) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', event)
    }, { type: 'chat:error', channel: 'bot-vis-primary', message: 'Could not finish' })
    await emit('vis-primary', false)
    await clear('error')
  })

  test('the bell shows the notice bot avatar or the comet face', async () => {
    await page.getByTestId('notices-bell').click()
    const garden = page.getByTestId('notices-item').filter({ hasText: 'Garden notice' })
    const avatar = garden.locator('.notices-item-icon .bot-avatar[data-size="20"][data-state="idle"]')
    await expect(avatar).toBeVisible()
    await square(avatar, 20)
    await expect(garden.locator('[data-icon="comet-face"]')).toHaveCount(0)
    const plain = page.getByTestId('notices-item').filter({ hasText: 'Plain notice' })
    await expect(plain.locator('.notices-item-icon [data-icon="comet-face"]')).toHaveCount(1)
    await expect(plain.locator('.bot-avatar')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('avatars come back after a reload', async () => {
    await page.reload()
    await expect(page.getByTestId('shell')).toBeVisible()
    await showEarlier()
    await expect(row('vis-chat').locator('.bot-avatar svg')).toBeVisible()
  })
})
