import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { closeTestApp, createBotFromPlus } from './navigation.js'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page
let ids: string[]

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const vault = await mkdtemp(join(TMP, 'e2e-new-chat-focus-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: {
      ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-new-chat-focus-userdata-')),
      ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
    },
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.botsList().then(() => true).catch(() => false))).toBe(true)
  ids = await page.evaluate(async () => {
    const ids: string[] = []
    for (const name of ['Research scout', 'Release planning']) ids.push((await window.engram.botCreate({ name, purpose: '' })).id)
    return ids
  })
})

test.afterAll(async () => { await closeTestApp(app) })

test('a new chat made with + takes the keyboard, another chat keeps its draft, and a click in the composer returns focus; no pane grid exists', async () => {
  await page.setViewportSize({ width: 1600, height: 900 })
  for (const count of [1, 2, 4]) await expect(page.getByTestId(`mission-layout-${count}`)).toHaveCount(0)
  await expect(page.getByTestId('mission-add-menu')).toHaveCount(0)
  const other = page.getByTestId(`bot-${ids[0]!}`)
  const input = page.getByTestId('bots-input')
  await other.click()
  await expect(other).toHaveClass(/active/)
  await input.fill('Keep this draft')

  await createBotFromPlus(page, 'Fresh chat')
  const fresh = page.getByTestId('app-sidebar').locator('.bots-row', { hasText: 'Fresh chat' })
  await expect(fresh).toHaveClass(/active/)
  await expect(input).toHaveValue('')
  await expect(input).toBeFocused()
  await page.keyboard.type('hello')
  await expect(input).toHaveValue('hello')

  await page.locator('[data-testid="topbar"] .topbar-spacer').click()
  await expect(input).not.toBeFocused()
  await input.click()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('hello')

  await other.click()
  await expect(other).toHaveClass(/active/)
  await expect(input).toHaveValue('Keep this draft')
  await fresh.click()
  await expect(input).toHaveValue('hello')
})
