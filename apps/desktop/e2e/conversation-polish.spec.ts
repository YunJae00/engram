import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2 } from 'core'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openActivity, openWelcome } from './navigation.js'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test.beforeAll(async () => {
  await mkdir(tmp, { recursive: true })
  const vault = await mkdtemp(join(tmp, 'e2e-polish-vault-'))
  const paths = await initVault(vault, { git: false })
  await resetBotsToV2(paths) // a v2 list keeps the seeded bots through launch
  const bot = await createBot(paths, { name: '한국어 대화' })
  await appendBotTurn(paths, bot.id, { role: 'user', text: '한국어 입력은 유지', at: '2020-09-11T12:00:00Z' })
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: vault, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-polish-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1', ENGRAM_DEVELOPER_FIXTURE: '1' } })
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
  // The sidebar has no 24h filter or Show earlier since the bot sidebar redesign: a 2020 conversation is listed
  // with the rest, and its row carries the full date as a hover title instead of a visible timestamp.
  await expect(page.getByTestId('sidebar-earlier')).toHaveCount(0)
  const row = page.locator('.bots-row', { hasText: '한국어 대화' })
  await expect(row).toBeVisible()
  await expect(row.locator('time')).toHaveCount(0)
  await expect(row.locator('.sidebar-conversation-content')).toHaveAttribute('title', /9\/11\/2020/)
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
  await chat.getByRole('button', { name: 'Reset memory conversation' }).click()
  await expect(chat.locator('.bubble-msg')).toHaveCount(0)
  await expect(chat.getByTestId('cosmos-chat-input')).toBeFocused()
})

test('external connections are explicitly enabled and can be disabled without altering clients', async () => {
  await app.evaluate(({ ipcMain }) => {
    let configured = false
    ipcMain.removeHandler('mcp:clients'); ipcMain.removeHandler('mcp:connectDesktop')
    ipcMain.handle('mcp:clients', async () => {
      await new Promise(resolve => setTimeout(resolve, 400))
      return [{ id: 'claude', state: 'not-configured' }, { id: 'codex', state: 'not-configured' }, { id: 'desktop', state: configured ? 'configured' : 'not-configured' }]
    })
    ipcMain.handle('mcp:connectDesktop', async () => { await new Promise(resolve => setTimeout(resolve, 800)); configured = true; return { ok: true } })
  })
  await openActivity(page, 'settings')
  const panel = page.getByRole('region', { name: 'External connections', exact: true })
  const toggle = panel.getByRole('switch')
  await expect(toggle).not.toBeChecked()
  await panel.locator('summary').filter({ hasText: /^Apps and configuration$/ }).click()
  await expect(panel.getByRole('button', { name: 'Connect', exact: true }).first()).toBeDisabled()
  await toggle.check()
  await expect(panel.getByRole('button', { name: 'Connect', exact: true }).first()).toBeEnabled()
  await expect(panel.getByRole('status')).toContainText('Ready')
  const desktop = panel.getByTestId('external-client-desktop')
  await desktop.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(desktop.getByRole('button', { name: 'Connecting…' })).toBeDisabled()
  await expect(desktop.getByRole('button', { name: 'Configured', exact: true })).toBeDisabled()
  await expect(desktop).toContainText('Reload the client')
  await screenshot('release-112-connections.png')
  await page.keyboard.press('Escape')
  await openActivity(page, 'settings')
  await expect(desktop.getByRole('button', { name: 'Configured', exact: true })).toBeDisabled()
  await toggle.uncheck()
  await expect(panel.getByRole('status')).toContainText('Off')
  await page.keyboard.press('Escape')
})

test('the welcome composer has no web button, bookmarks or import: its + attaches a file and a typed message starts the chat', async () => {
  await openActivity(page, 'bots')
  await openWelcome(page)
  const add = page.getByTestId('welcome-input-add')
  await expect(add).toHaveAttribute('aria-label', 'Attach files')
  const chooser = page.waitForEvent('filechooser')
  await add.click()
  await (await chooser).setFiles([])
  for (const id of ['welcome-web', 'chat-add-menu']) await expect(page.getByTestId(id)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Bookmarks', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Import bookmarks…' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: /bookmarks/i })).toHaveCount(0)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await screenshot('release-111-bookmarks.png')
  await page.getByTestId('welcome-input').fill('Open my bookmarks')
  await page.getByTestId('welcome-input').press('Enter')
  await expect(page.locator('[data-testid="bots-view"] .bubble-msg.user')).toHaveText(['Open my bookmarks'])
  await expect(page.getByTestId('bots-input')).toBeVisible()
  await screenshot('release-112-bookmark-folders.png')
})
