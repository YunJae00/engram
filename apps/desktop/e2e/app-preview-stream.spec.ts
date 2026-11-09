import { expect, test, _electron as electron } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
async function launchStreamFixture() {
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
      const counts = { opened: 0, closed: 0 }
      Object.assign(window, { streamCounts: counts })
      navigator.mediaDevices.getDisplayMedia = async () => {
        counts.opened++
        const canvas = document.createElement('canvas')
        canvas.width = 320; canvas.height = 200
        const context = canvas.getContext('2d')!
        const stream = canvas.captureStream(24)
        // Canvas capture produces new frames only when the source is painted.
        let frame = 0
        const timer = setInterval(() => { context.fillStyle = `rgb(${frame++ % 255}, 80, 120)`; context.fillRect(0, 0, 320, 200) }, 40)
        stream.getVideoTracks()[0]!.addEventListener('ended', () => clearInterval(timer))
        const track = stream.getVideoTracks()[0]!
        const stop = track.stop.bind(track)
        track.stop = () => { counts.closed++; clearInterval(timer); stop() }
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
    return { app, page, lane, bot }
  } catch (error) { await closeTestApp(app); throw error }
}
test('paints an owned app stream within two seconds of binding and keeps it after the turn', async () => {
  const { app, page, lane } = await launchStreamFixture()
  try {
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
    // A newer web card covers the app in the same lane; capture must stay open.
    await app.evaluate(({ BrowserWindow }, lane) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents
      contents.send('engram:event', { type: 'comet:step', channel: lane, line: 'read_open_page: Preview' })
      contents.send('engram:event', { type: 'agent:frame', lane, url: 'https://example.test/stream', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', width: 320, height: 200 })
    }, lane)
    const deck = page.getByTestId('preview-deck')
    await expect(deck.locator('[data-position]')).toHaveCount(2)
    await expect(deck.locator('[data-position="0"]')).toHaveAttribute('data-frame', `${lane}:web:https://example.test/stream`)
    await expect(deck.getByRole('button', { name: 'Owned stream', exact: true }).locator('img')).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { streamCounts: { opened: number; closed: number } }).streamCounts)).toEqual({ opened: 1, closed: 0 })
    await deck.getByRole('button', { name: 'Owned stream', exact: true }).press('Enter')
    await expect(painted).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { streamCounts: { opened: number; closed: number } }).streamCounts)).toEqual({ opened: 1, closed: 0 })

    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'chat:done', channel: lane, text: 'Done.' }), lane)
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: false }), lane)
    await expect(page.getByTestId('preview-card')).toContainText('Live')
    expect(await page.evaluate(() => (window as unknown as { streamCounts: { opened: number; closed: number } }).streamCounts)).toEqual({ opened: 1, closed: 0 })
    await expect(page.getByTestId('preview-card').locator('canvas[data-painted], img')).toBeVisible()
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'press:ask', channel: lane, words: 'Confirm local action', host: 'example.test' }), lane)
    await expect(page.getByTestId('preview-card')).toBeVisible()
    await expect(page.getByTestId('preview-card')).toContainText('Needs you')
    await page.getByTestId('preview-card').getByRole('button', { name: 'Collapse preview' }).click()
    await expect(painted).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'chat:done', channel: lane, text: 'Done.' }), lane)
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: true }), lane)
    await expect(page.getByTestId('preview-card-collapsed')).toBeVisible()
    await page.getByTestId('preview-card-collapsed').click()
    await expect(painted).toBeVisible()
  } finally { await closeTestApp(app) }
})

test('rebinding the lane to another window keeps the earlier card on its own app and moves Live to the new card', async () => {
  const { app, page, lane } = await launchStreamFixture()
  const counts = () => page.evaluate(() => (window as unknown as { streamCounts: { opened: number; closed: number } }).streamCounts)
  const bind = (source: string, name: string) => app.evaluate(({ ipcMain, BrowserWindow }, { lane, source, name }) => {
    ipcMain.removeHandler('desktop:bindings')
    ipcMain.handle('desktop:bindings', () => [{ lane, source, name, readable: true }])
    BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'desktop:changed' })
  }, { lane, source, name })
  try {
    await bind('window:42:0', 'Owned stream')
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: true }), lane)
    const deck = page.getByTestId('preview-deck')
    const front = deck.locator('[data-position="0"] [data-testid="preview-card"]')
    await expect(front.locator('canvas[data-painted]')).toBeVisible({ timeout: 2000 })
    await expect(front).toContainText('Live')
    expect(await counts()).toEqual({ opened: 1, closed: 0 })
    await bind('window:43:0', 'Second app')
    await expect(deck.locator('[data-position="0"]')).toHaveAttribute('data-frame', `${lane}:window:43:0`)
    await expect(front.locator('.preview-card-caption')).toContainText('Second app')
    await expect(front.locator('canvas[data-painted]')).toBeVisible({ timeout: 2000 })
    await expect(front).toContainText('Live')
    const owned = deck.getByRole('button', { name: 'Owned stream', exact: true })
    await expect(owned.locator('img')).toBeVisible()
    await expect.poll(counts).toEqual({ opened: 2, closed: 1 })
    await owned.press('Enter')
    await expect(deck.locator('[data-position="0"]')).toHaveAttribute('data-frame', `${lane}:window:42:0`)
    await expect(front.locator('.preview-card-caption')).toContainText('Owned stream')
    await expect(front.locator('.preview-card-caption')).not.toContainText('Live')
    await expect(front.locator('canvas[data-painted]')).toHaveCount(0)
    await expect(deck.getByRole('button', { name: 'Second app', exact: true })).toBeVisible()
  } finally { await closeTestApp(app) }
})
