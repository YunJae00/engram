import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EngramEvent } from '../src/shared/types.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let ids: string[]

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-activity-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-activity-userdata-')),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow({ timeout: 60_000 })
  await page.setViewportSize({ width: 1440, height: 940 })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  ids = await page.evaluate(async () => {
    const bots = await Promise.all(['Research scout', 'Review request', 'Release planning', 'Next project'].map((name) => window.engram.botCreate({ name, purpose: '' })))
    const seats = bots.map((bot) => bot.id)
    localStorage.setItem('engram.mission.slots', JSON.stringify(seats))
    return seats
  })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:send')
    ipcMain.handle('chat:send', (_event, request) => ({ channel: request.channel }))
  })
})

test.afterAll(async () => { await app?.close() })

async function emit(event: EngramEvent) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', payload)
  }, event)
}

test('low memory rejects a new embedded browser without blocking the app', async () => {
  test.skip(process.platform !== 'win32', 'Embedded browser is Windows-only')
  const message = await app.evaluate(async ({ BrowserWindow }) => {
    const os = process.getBuiltinModule('node:os') as typeof import('node:os')
    const original = os.freemem
    os.freemem = () => 1e9
    try {
      return await BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
        "window.engram.agentGo('https://example.com', 'bot-memory-check').then(() => '', error => error.message)",
      ) as string
    } finally { os.freemem = original }
  })
  expect(message).toContain('not enough free memory')
  expect(await page.evaluate(() => window.engram.botsList())).toHaveLength(4)
})

test('sidebar navigation and activity indicators share the same icon and label columns', async () => {
  const orbitIcon = page.getByTestId('activity-mission').locator('svg')
  await expect(orbitIcon).toHaveAttribute('data-icon', 'orbit')
  await expect(orbitIcon).toHaveAttribute('viewBox', '0 0 24 24')
  await expect(orbitIcon).toHaveAttribute('aria-hidden', 'true')
  expect(await orbitIcon.innerHTML()).not.toBe(await page.getByTestId('activity-sky').locator('svg').innerHTML())
  await emit({ type: 'filing:start' })
  await expect(page.getByTestId('sweep-status')).toBeVisible()
  const positions = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.sidebar-nav-row, .sidebar-status-row')]
    return rows.map((row) => {
      const icon = row.firstElementChild!.getBoundingClientRect()
      return { center: icon.left + icon.width / 2, label: row.lastElementChild!.getBoundingClientRect().left }
    })
  })
  expect(positions).toHaveLength(6)
  expect(Math.max(...positions.map((p) => p.center)) - Math.min(...positions.map((p) => p.center))).toBeLessThanOrEqual(1)
  expect(Math.max(...positions.map((p) => p.label)) - Math.min(...positions.map((p) => p.label))).toBeLessThanOrEqual(1)
  await emit({ type: 'filing:done' })
})

test('each chat and mission border tracks running, input needed, error and completion independently', async () => {
  await page.getByTestId('activity-mission').click()
  await expect(page.locator('.mission-tile .mini-chat')).toHaveCount(4)
  for (const id of ids.slice(0, 3)) {
    const input = page.getByTestId(`mini-chat-${id}`).locator('input')
    await expect(input).toBeEnabled()
    await input.fill('Review the current task')
    await input.press('Enter')
    await expect(page.getByTestId(`bot-${id}`).locator('.comet-activity-icon')).toHaveAttribute('data-state', 'running')
  }
  await emit({ type: 'press:ask', channel: `bot-${ids[1]}`, words: 'Submit this review?', host: 'example.com' })
  await emit({ type: 'chat:error', channel: `bot-${ids[2]}`, message: 'Connection interrupted' })
  for (const [index, state, label] of [[0, 'running', 'Running'], [1, 'waiting', 'Needs input'], [2, 'error', 'Needs attention'], [3, 'ready', 'Ready']] as const) {
    const tile = page.getByTestId(`mission-tile-${index}`)
    await expect(tile).toHaveAttribute('data-state', state)
    await expect(tile.locator('.mission-status')).toHaveText(label)
    const icon = page.getByTestId(`bot-${ids[index]}`).locator('.comet-activity-icon')
    if (state === 'ready') await expect(icon).toHaveCount(0)
    else await expect(icon).toHaveAttribute('aria-label', label)
  }
  await expect.poll(() => page.locator('.mission-tile').evaluateAll((tiles) => new Set(tiles.map((tile) => getComputedStyle(tile).borderTopColor)).size)).toBe(4)
  await page.screenshot({ path: join(TMP, 'activity-light.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.screenshot({ path: join(TMP, 'activity-dark.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByTestId(`bot-${ids[0]}`).locator('.comet-activity-icon')).toHaveCSS('animation-name', 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const retry = page.getByTestId(`mini-chat-${ids[2]}`).locator('input')
  await retry.fill('Try again')
  await retry.press('Enter')
  await expect(page.getByTestId('mission-tile-2')).toHaveAttribute('data-state', 'running')
  for (const id of ids.slice(0, 3)) await emit({ type: 'chat:done', channel: `bot-${id}`, text: 'Complete' })
  await expect(page.locator('.mission-tile[data-state="ready"]')).toHaveCount(4)
  await expect(page.locator('.sidebar-item-main .comet-activity-icon')).toHaveCount(0)
  const next = page.getByTestId(`mini-chat-${ids[1]}`).locator('input')
  await next.fill('A new task')
  await next.press('Enter')
  await expect(page.getByTestId('mission-tile-1')).toHaveAttribute('data-state', 'running')
  await emit({ type: 'chat:done', channel: `bot-${ids[1]}`, text: 'Complete' })
})

test('sidebar groups animate height, remain interruptible and remove collapsed controls from focus', async () => {
  for (const group of ['chats', 'routines']) {
    const toggle = page.getByTestId(`sidebar-${group}-toggle`)
    const content = page.locator(`#sidebar-${group}-content`)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const heights = await page.evaluate(async (name) => {
      const panel = document.getElementById(`sidebar-${name}-content`)!
      const button = document.querySelector<HTMLButtonElement>(`[data-testid="sidebar-${name}-toggle"]`)!
      const start = panel.getBoundingClientRect().height
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const motion = panel.getAnimations().find((animation) => animation instanceof CSSTransition && animation.transitionProperty === 'grid-template-rows')
      if (!motion) return [start, start, panel.getBoundingClientRect().height]
      motion.pause()
      motion.currentTime = 110
      const middle = panel.getBoundingClientRect().height
      motion.finish()
      return [start, middle, panel.getBoundingClientRect().height]
    }, group)
    expect(heights[1]).toBeGreaterThan(0)
    expect(heights[1]).toBeLessThan(heights[0]!)
    expect(heights.at(-1)).toBe(0)
    await expect(content).not.toBeVisible()
    expect(await content.locator('.sidebar-disclosure-content').evaluate((node) => (node as HTMLElement).inert)).toBe(true)
    await toggle.click()
    await toggle.click()
    await toggle.click()
    await expect(content).toBeVisible()
    await expect(content).toHaveAttribute('data-settled', 'true')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  }
})

test('settings loading uses the same padded header and content on compact and wide screens', async () => {
  const settings = await page.evaluate(() => window.engram.settingsGet())
  await page.evaluate(() => {
    const original = window.setTimeout
    const control = window as typeof window & { restoreSettingsTimer?: () => void }
    control.restoreSettingsTimer = () => { window.setTimeout = original }
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => original(handler, delay === 8000 ? 120_000 : delay, ...args)) as typeof window.setTimeout
  })
  await app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler('settings:get')
    ipcMain.handle('settings:get', () => new Promise((resolve) => {
      const control = globalThis as typeof globalThis & { engramSettingsRelease?: () => void }
      control.engramSettingsRelease = () => resolve(value)
    }))
  }, settings)
  for (const width of [1280, 620]) {
    await page.setViewportSize({ width, height: 720 })
    if (!await page.getByTestId('app-sidebar').isVisible()) await page.getByTestId('app-sidebar-open').click()
    await page.getByTestId('activity-settings').click()
    const loading = page.getByTestId('settings-loading')
    await expect(loading).toBeVisible()
    expect(await loading.evaluate((node) => {
      const box = node.getBoundingClientRect()
      const title = node.querySelector('.dialog-title')!.getBoundingClientRect()
      const row = node.querySelector('.settings-skeleton-row')!.getBoundingClientRect()
      const scroll = node.querySelector('.settings-scroll')!
      const contentLeft = scroll.getBoundingClientRect().left + parseFloat(getComputedStyle(scroll).paddingLeft)
      return { aligned: Math.abs(contentLeft - row.left) <= 1 && title.left > box.left, padded: row.left - box.left >= 16 && box.right - row.right >= 16, fits: box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight }
    })).toEqual({ aligned: true, padded: true, fits: true })
    await page.screenshot({ path: join(TMP, `settings-loading-${width}.png`) })
    await app.evaluate(() => {
      const control = globalThis as typeof globalThis & { engramSettingsRelease?: () => void }
      control.engramSettingsRelease?.()
      delete control.engramSettingsRelease
    })
    await expect(page.getByTestId('settings-view')).toBeVisible()
    await page.keyboard.press('Escape')
  }
  await page.evaluate(() => {
    const control = window as typeof window & { restoreSettingsTimer?: () => void }
    control.restoreSettingsTimer?.()
    delete control.restoreSettingsTimer
  })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('settings:get')
    ipcMain.handle('settings:get', () => { throw new Error('Settings unavailable') })
  })
  await page.getByTestId('activity-settings').click()
  await expect(page.getByRole('alert')).toContainText('Settings could not be loaded')
  await app.evaluate(({ ipcMain }, value) => {
    ipcMain.removeHandler('settings:get')
    ipcMain.handle('settings:get', () => value)
  }, settings)
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(page.getByTestId('settings-view')).toBeVisible()
  await page.keyboard.press('Escape')
})
