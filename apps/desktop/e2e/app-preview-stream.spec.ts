import { expect, test, _electron as electron } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
test('paints an owned app stream within two seconds of binding and keeps it after the turn', async () => {
  await mkdir(TMP, { recursive: true })
  const paths = await initVault(await mkdtemp(join(TMP, 'app-stream-')), { git: false })
  const bot = await createBot(paths, { name: 'Stream fixture' })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: 'Ready.', at: new Date().toISOString() })
  const lane = `bot-${bot.id}`
  const app = await electron.launch({
    args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
    env: { ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(TMP, 'app-stream-user-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await page.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 320; canvas.height = 200
        const context = canvas.getContext('2d')!
        const stream = canvas.captureStream(24)
        // Canvas capture produces new frames only when the source is painted.
        let frame = 0
        const timer = setInterval(() => { context.fillStyle = `rgb(${frame++ % 255}, 80, 120)`; context.fillRect(0, 0, 320, 200) }, 40)
        stream.getVideoTracks()[0]!.addEventListener('ended', () => clearInterval(timer))
        return stream
      }
    })
    await app.evaluate(({ ipcMain }, lane) => {
      const handlers: Record<string, () => unknown> = {
        'desktop:available': () => true, 'desktop:bindings': () => [],
        'desktop:previews': () => [{ id: `${lane}:window:42:0`, lane, title: 'Owned stream', at: Date.now(), captureState: 'waiting' }],
        'desktop:prepare': () => 'owned-fixture', 'desktop:cancelCapture': () => undefined,
      }
      for (const [channel, handler] of Object.entries(handlers)) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
    }, lane)
    await page.reload()
    // Live previews require a visible window; hidden Windows capture can stall.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.showInactive())
    await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    await page.getByTestId('bots-input').focus()
    await app.evaluate(({ ipcMain, BrowserWindow }, lane) => {
      ipcMain.removeHandler('desktop:bindings')
      ipcMain.handle('desktop:bindings', () => [{ lane, source: 'window:42:0', name: 'Owned stream', readable: true }])
      BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'desktop:changed' })
    }, lane)
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: true }), lane)
    const painted = page.getByTestId('preview-card').locator('canvas[data-painted]')
    await expect(painted).toBeVisible({ timeout: 2000 })
    await expect(page.getByTestId('preview-card')).toContainText('Live')
    await expect(page.getByTestId('bots-input')).toBeFocused()
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'chat:done', channel: lane, text: 'Done.' }), lane)
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: false }), lane)
    await expect(page.getByTestId('preview-card')).toContainText('Last snapshot')
    await expect(page.getByTestId('preview-card').locator('canvas[data-painted], img')).toBeVisible()
    await page.getByTestId('preview-card').getByRole('button', { name: 'Collapse preview' }).click()
    await expect(painted).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'chat:done', channel: lane, text: 'Done.' }), lane)
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: true }), lane)
    await expect(page.getByTestId('preview-card-collapsed')).toBeVisible()
    await page.getByTestId('preview-card-collapsed').click()
    await expect(painted).toBeVisible()
  } finally { await closeTestApp(app) }
})
