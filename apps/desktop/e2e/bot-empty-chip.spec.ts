import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DRAFT = 'my unsent draft, keep it'
type Fixture = typeof globalThis & { requests: string[] }

let app: ElectronApplication, page: Page, botId: string
test.beforeEach(async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-bot-empty-chip-'))
  await initVault(root, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-bot-empty-chip-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  botId = await page.evaluate(async () => (await window.engram.botCreate({ name: 'Empty chip fixture', purpose: 'Has not been asked anything yet.' })).id)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    const fixture = globalThis as Fixture
    fixture.requests = []
    for (const channel of ['chat:send', 'chat:active', 'chat:say']) ipcMain.removeHandler(channel)
    ipcMain.handle('chat:active', () => [])
    // Never resolves: the example stays the sent message while the draft is checked.
    ipcMain.handle('chat:send', (_event, request) => new Promise<void>(() => { fixture.requests.push(request.message) }))
    ipcMain.handle('chat:say', () => ({ ok: false }))
  })
  const row = page.getByTestId(`bot-${botId}`), earlier = page.getByTestId('sidebar-earlier')
  if (!await row.isVisible() && await earlier.isVisible()) await earlier.click()
  await row.click()
  await expect(page.locator('[data-testid="bots-thread"] [data-testid="bot-empty"]')).toBeVisible()
})
test.afterEach(async () => { await app?.close() })

const requests = () => app.evaluate(() => (globalThis as Fixture).requests)

test('an empty-bot example sends only its own text and keeps the unsent draft', async () => {
  const input = page.locator('[data-testid="bots-view"] [data-testid="bots-input"]')
  await input.fill(DRAFT)
  const chip = page.getByTestId('bot-empty-chip').first()
  const example = (await chip.textContent())!.trim()
  expect(example).not.toBe('')
  await chip.click()
  await expect.poll(requests).toEqual([example])
  await expect(page.locator('.bubble-msg.user').last()).toHaveText(example)
  await expect(page.getByTestId('bot-empty')).toHaveCount(0)
  await expect(input).toHaveValue(DRAFT)
  await page.waitForTimeout(500)
  expect(await requests()).toEqual([example])
  await expect(input).toHaveValue(DRAFT)
})
