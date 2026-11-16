import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createBot, initVault, type VaultPaths } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))
let app: ElectronApplication
let page: Page
let paths: VaultPaths
test.beforeAll(async () => {
  await mkdir(REPO_TMP, { recursive: true })
  const root = await mkdtemp(join(REPO_TMP, 'e2e-failed-draft-'))
  paths = await initVault(root, { git: false })
  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(REPO_TMP, 'e2e-failed-draft-userdata-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'mock', ENGRAM_HIDDEN: '1' },
  })
  page = await app.firstWindow()
})
test.afterAll(async () => { await app?.close() })

test('a message typed after a failed send replaces the put-back draft instead of joining it', async () => {
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.engram.botsList()).then(() => true, () => false)).toBe(true)
  const bot = await createBot(paths, { name: 'Failed draft check' })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('chat:send')
    // As in the app: the error arrives while the send is still open.
    ipcMain.handle('chat:send', (event, request: { channel: string }) => { event.sender.send('engram:event', { type: 'chat:error', channel: request.channel, message: 'Connection failed' }); return { ok: true } })
  })
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await app.evaluate(async ({ BrowserWindow }) => { await BrowserWindow.getAllWindows()[0]!.webContents.capturePage() })
  if (await page.getByTestId('app-sidebar-open').isVisible()) await page.getByTestId('app-sidebar-open').click()
  await page.getByTestId(`bot-${bot.id}`).click()
  const input = page.getByTestId('bots-input')
  await input.fill('이대로 진행')
  await input.press('Enter')
  await expect(input).toHaveValue('이대로 진행')
  // The failure is one plain line in the thread's language: no raw error, no retry, details or copy to press.
  const failed = page.locator('.bubble-msg.error')
  await expect(failed).toHaveText(['문제가 생겨서 이번 건 끝내지 못했어요. 한 번 더 말씀해 주시면 다시 해볼게요.'])
  await expect(failed).not.toContainText('Connection failed')
  await expect(failed.locator('button, details, summary, pre')).toHaveCount(0)
  // The put-back draft arrives selected: the next message typed replaces it.
  await expect(input).toBeFocused()
  await page.keyboard.type('이어서 해줘')
  await expect(input).toHaveValue('이어서 해줘')
  await page.keyboard.press('Enter')
  await expect(page.locator('.bubble-msg.user').last()).toHaveText('이어서 해줘')
  await expect(input).toHaveValue('이어서 해줘')
  // A click places the caret as usual: a small correction keeps the draft.
  // The click lands past the short text, so the caret is at its end.
  await input.click()
  await page.keyboard.type('!')
  await expect(input).toHaveValue('이어서 해줘!')
  await page.keyboard.press('Enter')
  await expect(page.locator('.bubble-msg.error')).toHaveCount(3)
  await expect(input).toHaveValue('이어서 해줘!')
  // Sent again unchanged and failed again: it is not put back a second time.
  await input.press('Enter')
  await expect(page.locator('.bubble-msg.error')).toHaveCount(4)
  await expect(input).toHaveValue('')
})
