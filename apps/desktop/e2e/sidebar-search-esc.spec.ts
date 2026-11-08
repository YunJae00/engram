import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createBot, initVault, type VaultPaths } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp } from './navigation.js'

test.describe.configure({ mode: 'serial' })
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication, page: Page, paths: VaultPaths

test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-sidebar-search-esc-vault-'))
  paths = await initVault(vault, { git: false })
  for (const name of ['Alpha chat', 'Beta chat']) await createBot(paths, { name })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-sidebar-search-esc-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow()
  await page.evaluate(() => localStorage.setItem('engram.tour.done', '1'))
  await expect(page.getByTestId('shell')).toBeVisible()
})
test.afterAll(async () => { await closeTestApp(app) })

const sidebar = () => page.getByTestId('app-sidebar')
const search = () => page.getByRole('textbox', { name: 'Search conversations' })
const conversations = () => sidebar().getByRole('region', { name: 'Conversations' })

test('Esc clears a sidebar search and restores the conversation list', async () => {
  await page.setViewportSize({ width: 1280, height: 900 })
  if (await sidebar().getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await expect(conversations().getByText('Alpha chat')).toBeVisible()
  await search().fill('zzz-no-such-chat')
  await expect(conversations().getByText('No matches found')).toBeVisible()
  await search().press('Escape')
  await expect(search()).toHaveValue('')
  await expect(conversations().getByText('No matches found')).toHaveCount(0)
  await expect(conversations().getByText('Alpha chat')).toBeVisible()
  await expect(conversations().getByText('Beta chat')).toBeVisible()
})

test('in the narrow overlay the first Esc clears the query and the second closes the sidebar', async () => {
  await page.setViewportSize({ width: 780, height: 720 })
  if (await sidebar().getAttribute('aria-hidden') === 'true') await page.getByTestId('app-sidebar-open').click()
  await expect(sidebar()).toHaveAttribute('aria-hidden', 'false')
  await search().fill('zzz-no-such-chat')
  await expect(conversations().getByText('No matches found')).toBeVisible()
  await search().press('Escape')
  await expect(search()).toHaveValue('')
  await expect(sidebar()).toHaveAttribute('aria-hidden', 'false')
  await expect(conversations().getByText('Alpha chat')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sidebar()).toHaveAttribute('aria-hidden', 'true')
})
