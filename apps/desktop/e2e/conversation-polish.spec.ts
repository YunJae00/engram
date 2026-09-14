import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity } from './navigation.js'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-polish-vault-'))
  await initVault(vault, { git: false })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-polish-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 1280, height: 900 })
})
test.afterAll(async () => { await app?.close() })
async function screenshot(file: string) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(one => one.webContents.getURL().includes('index.html'))!
    await window.webContents.capturePage()
    await new Promise(resolve => setTimeout(resolve, 400))
    return (await window.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(join(tmp, file), Buffer.from(png, 'base64'))
}

test('Cosmos reads as a conversation with compact citations and no premature copy action', async () => {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('chat:send')
    ipcMain.handle('chat:send', (_event, request) => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'chat:token', channel: request.channel, text: 'Today we settled the release plan. [Release decision](note://n-release)\n\nThe next step is to verify the build.' })
    })
  })
  await openActivity(page, 'sky')
  const chat = page.getByTestId('cosmos-chat')
  await chat.getByTestId('cosmos-chat-input').fill('What did we decide today?')
  await chat.getByTestId('cosmos-chat-input').press('Enter')
  await expect(chat.locator('.cosmos-chat-heading [role="status"]')).toContainText('Replying')
  await expect(chat.locator('.answer-reference')).toHaveText('1')
  await expect(chat.getByRole('button', { name: 'Copy answer', exact: true })).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('engram:event', { type: 'chat:done', channel: 'cosmos', text: 'Today we settled the release plan. [Release decision](note://n-release)\n\nThe next step is to verify the build.' })
  })
  await expect(chat.getByRole('button', { name: 'Copy answer', exact: true })).toBeVisible()
  await chat.locator('.answer-memory-sources summary').click()
  await expect(chat.locator('.answer-memory-sources a')).toHaveText('Release decision')
  await screenshot('release-111-cosmos.png')
  await chat.getByRole('button', { name: 'New memory conversation' }).click()
  await expect(chat.locator('.bubble-msg')).toHaveCount(0)
  await expect(chat.getByTestId('cosmos-chat-input')).toBeFocused()
})

test('external connections are explicitly enabled and can be disabled without altering clients', async () => {
  await openActivity(page, 'settings')
  await page.getByTestId('settings-nav-connections').click()
  const panel = page.getByRole('region', { name: 'External connections', exact: true })
  const toggle = panel.getByRole('switch')
  await expect(toggle).not.toBeChecked()
  await expect(panel.getByRole('button', { name: 'Connect', exact: true }).first()).toBeDisabled()
  await toggle.check()
  await expect(panel.getByRole('button', { name: 'Connect', exact: true }).first()).toBeEnabled()
  await expect(panel.getByRole('status')).toContainText('Ready')
  await toggle.uncheck()
  await expect(panel.getByRole('status')).toContainText('Off')
  await page.keyboard.press('Escape')
})

test('bookmark import selects a browser profile in a readable modal', async () => {
  await app.evaluate(({ ipcMain }) => {
    for (const name of ['bookmarks:list', 'bookmarks:sources', 'bookmarks:import']) ipcMain.removeHandler(name)
    ipcMain.handle('bookmarks:list', () => [])
    ipcMain.handle('bookmarks:sources', () => [{ id: 'chrome:Default', name: 'Chrome · Work' }, { id: 'edge:Default', name: 'Edge · Personal' }])
    ipcMain.handle('bookmarks:import', (_event, id) => { if (id !== 'edge:Default') throw new Error('Wrong profile'); return [] })
  })
  await openActivity(page, 'bots')
  await page.getByTestId('bots-new').click()
  await page.getByTestId('welcome-web').click()
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click()
  await page.getByRole('button', { name: 'Import bookmarks…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Import bookmarks', exact: true })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate(node => {
    const box = node.getBoundingClientRect()
    return Math.abs(box.x + box.width / 2 - innerWidth / 2) < 1 && Math.abs(box.y + box.height / 2 - innerHeight / 2) < 7
  })).toBe(true)
  await dialog.getByLabel('Browser profile').selectOption('edge:Default')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await screenshot('release-111-bookmarks.png')
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Bookmarks', exact: true })).toBeFocused()
})
