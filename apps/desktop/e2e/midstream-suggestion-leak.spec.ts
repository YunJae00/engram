import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { appendBotTurn, createBot, initVault, resetBotsToV2, type VaultPaths } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
let app: ElectronApplication | undefined
test.afterEach(async () => { await app?.close(); app = undefined })

async function vault(): Promise<{ root: string; paths: VaultPaths }> {
  await mkdir(tmp, { recursive: true })
  const root = await mkdtemp(join(tmp, 'e2e-suggestion-leak-'))
  const paths = await initVault(root, { git: false })
  await resetBotsToV2(paths)
  return { root, paths }
}

async function launch(root: string, botId: string) {
  app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'e2e-suggestion-leak-data-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('shell')).toBeVisible()
  await expect(page.getByTestId(`bot-${botId}`)).toBeVisible()
  return page
}

test('a message sent mid-stream never shows the earlier answer suggestion tail', async () => {
  const { root, paths } = await vault()
  const botId = (await createBot(paths, { name: 'Leak fixture' })).id
  const page = await launch(root, botId)
  await app!.evaluate(({ ipcMain, BrowserWindow }) => {
    const fixture = globalThis as typeof globalThis & { pending: { request: { message: string; channel: string }; resolve(): void }[] }
    fixture.pending = []
    for (const channel of ['chat:send', 'chat:active', 'chat:abort', 'chat:say']) ipcMain.removeHandler(channel)
    ipcMain.handle('chat:active', () => fixture.pending.map(call => call.request.channel))
    ipcMain.handle('chat:send', (_event, request) => new Promise<void>(resolve => {
      fixture.pending.push({ request, resolve })
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'chat:token', channel: request.channel, text: 'Counted to thirty.\n\n```replies\nMore up to 50' })
    }))
    ipcMain.handle('chat:abort', () => { for (const call of fixture.pending.splice(0)) call.resolve() })
    ipcMain.handle('chat:say', (_event, _channel: string, text: string) => ({ ok: true, action: 'relay', instruction: text }))
  })
  const row = page.getByTestId(`bot-${botId}`)
  await row.click()
  const input = page.getByTestId('bots-input')
  await input.fill('Count to thirty'); await input.press('Enter')
  await expect(page.locator('.bubble-stop')).toBeVisible()
  await expect(page.locator('.bubble-msg.assistant', { hasText: 'Counted to thirty.' })).toHaveCount(1)
  await input.fill('Then only the even ones'); await input.press('Enter')
  await expect(page.locator('.bubble-msg.user')).toHaveText(['Count to thirty', 'Then only the even ones'])
  await app!.evaluate(({ BrowserWindow }) => {
    const fixture = globalThis as typeof globalThis & { pending: { request: { channel: string }; resolve(): void }[] }
    const call = fixture.pending.shift()!
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'chat:done', channel: call.request.channel, text: 'Counted to thirty.\n\n```replies\nMore up to 50\nUse themes\nThanks, that is all\n```' })
    call.resolve()
  })
  await expect(page.locator('.bubble-stop')).toHaveCount(0)
  const texts = await page.locator('.bubble-msg.assistant').allInnerTexts()
  for (const text of texts) {
    expect(text, `SUGGESTION-LEAK assistant bubble shows suggestion text: ${JSON.stringify(text)}`).not.toMatch(/up to 50|Use themes|that is all|```/)
    expect(text.trim(), `SUGGESTION-LEAK empty or placeholder assistant bubble: ${JSON.stringify(texts)}`).not.toMatch(/^…?$/)
  }
  expect(texts.filter(text => text.includes('Counted to thirty.')), `SUGGESTION-LEAK answer shown once: ${JSON.stringify(texts)}`).toHaveLength(1)
  await expect(page.locator('.bubble-msg.user'), 'SUGGESTION-LEAK user order').toHaveText(['Count to thirty', 'Then only the even ones'])
  const preview = await row.locator('.sidebar-conversation-preview').innerText()
  expect(preview, `SUGGESTION-LEAK sidebar preview: ${JSON.stringify(preview)}`).not.toMatch(/```|replies|up to 50|Use themes|that is all/)
})

test('sidebar preview shows the last reply without suggestion chips', async () => {
  const { root, paths } = await vault()
  const botId = (await createBot(paths, { name: 'Order fixture' })).id
  await appendBotTurn(paths, botId, { role: 'user', text: '순서테스트 3번, 숫자만 답해줘', at: new Date().toISOString() })
  await appendBotTurn(paths, botId, { role: 'assistant', text: '3\n\n```replies\n4번도 해줘\n고마워\n```', at: new Date().toISOString() })
  const page = await launch(root, botId)
  const row = page.getByTestId(`bot-${botId}`)
  await expect(row.locator('.sidebar-conversation-preview'), 'PREVIEW-CHIPS before open').toHaveText('3')
  await row.click()
  await expect(page.locator('.bubble-msg.assistant')).toHaveText(['3'])
  await expect(row.locator('.sidebar-conversation-preview'), 'PREVIEW-CHIPS after open').toHaveText('3')
})
