import { expect, test, _electron as electron } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApp, openActivity } from './navigation.js'

test('Office activity events show a localized card without an image', async () => {
  const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = await initVault(await mkdtemp(join(tmp, 'office-preview-')), { git: false })
  const bot = await createBot(paths, { name: 'Office preview' })
  await appendBotTurn(paths, bot.id, { role: 'user', text: '메일 확인해 줘', at: new Date().toISOString() })
  const app = await electron.launch({ args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'], env: {
    ...process.env, ENGRAM_VAULT: paths.root, ENGRAM_USERDATA: await mkdtemp(join(tmp, 'office-preview-user-')), ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1',
  } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByTestId('shell')).toBeVisible()
    await openActivity(page, 'bots')
    await page.getByTestId(`bot-${bot.id}`).click()
    const lane = `bot-${bot.id}`
    await app.evaluate(({ BrowserWindow }, lane) => {
      const send = (event: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', event)
      send({ type: 'comet:working', channel: lane, working: true })
      send({ type: 'desktop:preview', frames: [{ id: `office:${lane}`, lane, title: 'Outlook', activity: 'Checking your mail', captureState: 'activity', current: true, at: Date.now() }] })
    }, lane)
    const pill = page.getByTestId('preview-card-collapsed')
    if (await pill.isVisible()) await pill.click()
    const card = page.getByTestId('preview-card')
    await expect(card.locator('.preview-card-caption')).toHaveText('Outlook · 메일 확인')
    await expect(card.locator('.preview-card-state')).toHaveText('창 없이 Office에서 읽는 중')
    await expect(card.locator('img, canvas')).toHaveCount(0)
    await app.evaluate(({ BrowserWindow }, lane) => BrowserWindow.getAllWindows()[0]!.webContents.send('engram:event', { type: 'comet:working', channel: lane, working: false }), lane)
    await expect(pill).toBeVisible()
  } finally { await closeTestApp(app) }
})
