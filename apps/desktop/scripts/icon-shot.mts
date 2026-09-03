// The comets surfaces, photographed: rail, empty state, tab - where the mark
// actually lives.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/icon-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/icon-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
await createBot(paths, { name: 'reader', purpose: 'reads pages' })
await createBot(paths, { name: 'morning report', purpose: 'the morning rounds' })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' },
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
await page.keyboard.press('Control+l')
await page.getByTestId('bots-view').waitFor({ state: 'visible', timeout: 20_000 })
await page.waitForTimeout(800)
// A kept routine, so the rail's own list of them is in the picture.
await page.evaluate(async () => {
  const bots = await window.engram.botsList()
  if (bots[0]) await window.engram.botTaskAdd(bots[0].id, { name: 'Morning headlines', goal: 'Open the news front page and list the headlines' })
})
await page.waitForTimeout(400)
await page.locator('.bots-rail button', { hasText: 'reader' }).first().click().catch(() => {})
await page.waitForTimeout(400)
// The model picker, open, beside the composer - once the plan's list is in.
for (let i = 0; i < 40; i++) {
  const rows = (await page.evaluate(() => window.engram.modelsList())) as unknown[]
  if (rows.length > 0) break
  await page.waitForTimeout(1_000)
}
await page.getByTestId('model-picker').click().catch(() => {})
await page.waitForTimeout(300)
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/icon-shot.png', import.meta.url)) })
await app.close()
console.log('icon-shot: DONE')
