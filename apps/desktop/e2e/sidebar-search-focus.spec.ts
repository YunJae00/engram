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
  await expect(page.getByTestId('bots-new')).toBeEnabled()
})

test.afterAll(async () => { await app?.close() })

const search = () => page.getByRole('textbox', { name: 'Search conversations', exact: true })

test('typing without a click goes into the welcome composer', async () => {
  await expect(page.getByTestId('welcome-input')).toBeFocused()
  await page.keyboard.type('hello')
  await expect(page.getByTestId('welcome-input')).toHaveValue('hello')
  await expect(search()).toHaveValue('')
  await page.getByTestId('welcome-input').fill('')
})

test('Escape clears the conversation search', async () => {
  await search().click()
  await page.keyboard.type('stray text')
  await expect(search()).toHaveValue('stray text')
  await page.keyboard.press('Escape')
  await expect(search()).toHaveValue('')
})

test('a thread started during a non-matching search stays visible', async () => {
  await search().fill('nothing matches this')
  await expect(page.getByText('No matches found', { exact: true })).toBeVisible()
  const input = page.getByTestId('welcome-input')
  await input.fill('Plan the garden layout')
  await input.press('Enter')
  await expect(page.getByTestId('comet-welcome')).toHaveCount(0)
  const created = await page.evaluate(() => window.engram.botsList().then(list => list[0]!.id))
  await expect(page.getByTestId(`bot-${created}`)).toBeVisible()
  await expect(page.getByText('No matches found', { exact: true })).toHaveCount(0)
  await expect(search()).toHaveValue('nothing matches this')
})
