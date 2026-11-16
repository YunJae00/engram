import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test.describe.configure({ mode: 'serial' })
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  await mkdir(TMP, { recursive: true })
  const root = await mkdtemp(join(TMP, 'e2e-sidebar-search-focus-'))
  await initVault(root, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: root,
    ENGRAM_USERDATA: await mkdtemp(join(TMP, 'e2e-sidebar-search-focus-userdata-')),
    ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 840 })
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId('sidebar-create')).toBeEnabled()
})

test.afterAll(async () => { await app?.close() })

const sidebar = () => page.getByTestId('app-sidebar')
async function expectNoSearch(): Promise<void> {
  await expect(page.getByTestId('sidebar-search-toggle')).toHaveCount(0)
  await expect(sidebar().locator('.sidebar-search, input, textarea')).toHaveCount(0)
}

test('typing without a click goes into the welcome composer, and the sidebar has no search field to take it', async () => {
  await expect(page.getByTestId('welcome-input')).toBeFocused()
  await page.keyboard.type('hello')
  await expect(page.getByTestId('welcome-input')).toHaveValue('hello')
  await expectNoSearch()
  await page.getByTestId('welcome-input').fill('')
})

test('keys pressed on the sidebar reach no hidden search field, and Escape keeps the sidebar and the welcome', async () => {
  await page.getByTestId('sidebar-create').focus()
  await page.keyboard.type('straytext')
  await expectNoSearch()
  await expect(page.getByTestId('create-bot-dialog')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(sidebar()).toHaveAttribute('aria-hidden', 'false')
  await expect(page.getByTestId('comet-welcome')).toBeVisible()
  await page.getByTestId('welcome-input').fill('')
})

test('a thread started from the welcome is listed and active at once, with no search to hide it', async () => {
  await expectNoSearch()
  const input = page.getByTestId('welcome-input')
  await input.fill('Plan the garden layout')
  await input.press('Enter')
  await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
  // The primary Engram bot always leads the list; the welcome send starts the newest other conversation.
  const created = await page.evaluate(() => window.engram.botsList().then(list => list.filter(bot => !bot.primary).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.id))
  await expect(page.getByTestId(`bot-${created}`)).toBeVisible()
  await expect(page.getByTestId(`bot-${created}`)).toHaveClass(/active/)
  await expect(page.getByText('No matches found', { exact: true })).toHaveCount(0)
  await expectNoSearch()
})
