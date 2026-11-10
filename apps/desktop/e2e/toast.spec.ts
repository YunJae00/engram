import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const toast = () => page.locator('.toast')

test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-toast-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-toast-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow()
  await page.evaluate(() => localStorage.setItem('engram.tour.done', '1'))
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 800 })
})
test.afterAll(async () => { await closeTestApp(app) })

async function notice(message: string): Promise<number> {
  await app.evaluate(({ BrowserWindow }, text) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('engram:event', { type: 'task:notice', message: text })
  }, message)
  return Date.now()
}
async function goneAfter(from: number, limit: number): Promise<number> {
  while (Date.now() - from < limit) {
    if (await toast().count() === 0) return Date.now() - from
    await page.waitForTimeout(100)
  }
  return Infinity
}
async function center(): Promise<{ x: number; y: number }> {
  const box = (await toast().boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('toast shows an icon tile, title and close button and lets clicks through', async () => {
  await page.mouse.move(5, 700)
  await notice('Hello toast')
  await expect(toast()).toHaveAttribute('role', 'status')
  await expect(toast().locator('.toast-title')).toHaveText('Hello toast')
  await expect(toast().locator('.toast-icon')).toHaveAttribute('aria-hidden', 'true')
  expect((await toast().locator('.toast-close').getAttribute('aria-label'))?.trim()).toBeTruthy()
  const icon = (await toast().locator('.toast-icon').boundingBox())!
  const through = await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest('.toast'), { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 })
  expect(through).toBe(true)
  await toast().locator('.toast-close').click()
  await expect(toast()).toHaveCount(0, { timeout: 1000 })
})

test('toast stays about 6 seconds and pauses while hovered', async () => {
  await page.mouse.move(5, 700)
  const sent = await notice('Unhovered')
  await expect(toast()).toBeVisible()
  const gone = await goneAfter(sent, 9000)
  expect(gone).toBeGreaterThanOrEqual(5500)
  expect(gone).toBeLessThanOrEqual(8000)

  await notice('Hovered')
  await expect(toast()).toBeVisible()
  const { x, y } = await center()
  await page.mouse.move(x, y)
  await page.waitForTimeout(8000)
  await expect(toast()).toBeVisible()
  await page.mouse.move(5, 700)
  const left = Date.now()
  const after = await goneAfter(left, 9000)
  expect(after).toBeGreaterThanOrEqual(4000)
  expect(after).toBeLessThanOrEqual(7500)
})

test('a second toast with the same text restarts the timer', async () => {
  await page.mouse.move(5, 700)
  const t0 = await notice('Same')
  await expect(toast()).toBeVisible()
  await page.waitForTimeout(Math.max(0, t0 + 4000 - Date.now()))
  await notice('Same')
  await page.waitForTimeout(Math.max(0, t0 + 8000 - Date.now()))
  await expect(toast()).toBeVisible()
  expect(await goneAfter(t0, 11500)).toBeLessThanOrEqual(11500)
})

test('reduced motion turns the toast animation off', async () => {
  const name = () => toast().evaluate(el => getComputedStyle(el).animationName)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await notice('Reduced')
  await expect(toast()).toBeVisible()
  expect(await name()).toBe('none')
  await toast().locator('.toast-close').click()
  await expect(toast()).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await notice('Animated')
  await expect(toast()).toBeVisible()
  expect(await name()).not.toBe('none')
})
