// The update banner over a live conversation: does it float, or does it
// push the thread and the composer down?
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/banner-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/banner-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
const bot = await createBot(paths, { name: 'reader', purpose: 'reads pages' })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
await page.getByTestId(`bot-${bot.id}`).click()
const box = page.locator('.bots-write textarea')
const before = await box.boundingBox()
// The event the updater sends when a download has landed.
await app.evaluate(({ BrowserWindow }) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('engram:event', { type: 'update:ready', version: '9.9.9' })
})
await page.getByTestId('update-banner').waitFor({ state: 'visible', timeout: 5_000 })
await page.waitForTimeout(300)
const after = await box.boundingBox()
console.log(`composer top before the banner: ${Math.round(before?.y ?? -1)}px, after: ${Math.round(after?.y ?? -1)}px`)
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/banner-shot.png', import.meta.url)) })
await app.close()
console.log('banner-shot: DONE')
