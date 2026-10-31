import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

let app: ElectronApplication, page: Page, botId: string
test.beforeEach(async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-queue-'))
  const paths = await initVault(root, { git: false })
  botId = (await createBot(paths, { name: 'Queue fixture' })).id
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-queue-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId(`bot-${botId}`)).toBeVisible()
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const fixture = globalThis as typeof globalThis & { pending: { request: { message: string; channel: string }; resolve(): void }[]; requests: string[] }
    fixture.pending = []; fixture.requests = []
    for (const channel of ['chat:send', 'chat:active', 'chat:abort', 'chat:say']) ipcMain.removeHandler(channel)
    ipcMain.handle('chat:active', () => fixture.pending.map(call => call.request.channel))
    ipcMain.handle('chat:send', (_event, request) => new Promise<void>(resolve => {
      fixture.requests.push(request.message); fixture.pending.push({ request, resolve })
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'chat:token', channel: request.channel, text: 'Working on the current request.' })
    }))
    ipcMain.handle('chat:abort', () => { for (const call of fixture.pending.splice(0)) call.resolve() })
    ipcMain.handle('chat:say', (_event, _channel: string, text: string) => ({ ok: true, action: 'relay', instruction: text }))
  })
  await page.getByTestId(`bot-${botId}`).click()
  await expect(page.getByTestId('bots-input')).toBeVisible()
})
test.afterEach(async () => { await app?.close() })
async function finish() {
  await app.evaluate(({ BrowserWindow }) => {
    const fixture = globalThis as typeof globalThis & { pending: { request: { message: string; channel: string }; resolve(): void }[] }
    const call = fixture.pending.shift()!
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'chat:done', channel: call.request.channel, text: `Finished: ${call.request.message}` })
    call.resolve()
  })
}
async function requests() { return app.evaluate(() => (globalThis as typeof globalThis & { requests: string[] }).requests) }

test('words sent during a reply appear at once at the foot of the work, answered there, with no queue', async () => {
  const input = page.getByTestId('bots-input')
  await input.fill('First'); await input.press('Enter')
  await expect(page.locator('.bubble-stop')).toBeVisible()
  await input.fill('Only the recent ones'); await input.press('Enter')
  await input.fill('Then sum it up'); await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.locator('.comet-work-lines > li')).toHaveText(['Only the recent ones', 'Saved in the conversation.', 'Then sum it up', 'Saved in the conversation.'])
  await expect(page.getByTestId('queued-messages')).toHaveCount(0)
  await input.fill('Draft still being typed')
  expect(await requests()).toEqual(['First'])
  await finish()
  await expect(page.locator('.bubble-stop')).toHaveCount(0)
  expect(await requests()).toEqual(['First'])
  await expect(input).toHaveValue('Draft still being typed')
  await app.evaluate(({ BrowserWindow }, channel) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'chat:steer-returned', channel, texts: ['Only the recent ones'] }) }, `bot-${botId}`)
  await page.waitForTimeout(500)
  expect(await requests()).toEqual(['First'])
  await expect(page.locator('.bubble-msg.user')).toHaveCount(1)
})
test('Stop ends the work and what was set to follow, and nothing is sent after a reload', async () => {
  const input = page.getByTestId('bots-input')
  await input.fill('First'); await input.press('Enter')
  await input.fill('Then this'); await input.press('Enter')
  await expect(page.locator('.comet-work-line.you')).toHaveText('Then this')
  await page.locator('.bubble-stop').click()
  await expect(page.locator('.bubble-stop')).toHaveCount(0)
  await page.reload(); await expect(page.getByTestId('shell')).toBeVisible()
  await page.getByTestId(`bot-${botId}`).click()
  await expect(page.getByTestId('bots-input')).toBeVisible()
  await page.waitForTimeout(500)
  expect(await requests()).toEqual(['First'])
})
