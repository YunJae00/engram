// A real read-only turn that takes a few steps, so the comet offers to keep
// it: the picture shows what the offer looks like now, and what the page in
// the dock looks like with its images.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/keep-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/keep-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
const bot = await createBot(paths, { name: 'reader', purpose: 'reads pages' })

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' },
})
const page = await app.firstWindow()
await page.setViewportSize({ width: 1440, height: 900 })
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
for (let i = 0; i < 30; i++) {
  const engines = (await page.evaluate(() => window.engram.engines())) as { id: string }[]
  if (engines.some((e) => e.id === 'claude')) break
  await page.waitForTimeout(2_000)
}

let done = false
await page.exposeFunction('__turnDone', () => {
  done = true
})
await page.evaluate(`window.engram.onEvent((e) => { if (e.type === 'chat:done' || e.type === 'chat:error') window.__turnDone() })`)
await page.getByTestId(`bot-${bot.id}`).click()
const box = page.locator('.bots-write textarea')
await box.click()
await box.fill('open https://en.wikipedia.org/wiki/Seoul and read me the first paragraph')
await box.press('Enter')

let paneShot = false
for (let i = 0; i < 150 && !done; i++) {
  if (!paneShot && (await page.getByTestId('web-pane').isVisible().catch(() => false))) {
    await page.waitForTimeout(2_500)
    await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/pane-shot.png', import.meta.url)) })
    paneShot = true
  }
  await page.waitForTimeout(2_000)
}
await page.waitForTimeout(3_000)
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/keep-shot.png', import.meta.url)) })
const offer = await page.getByTestId('bots-offer-keep-card').isVisible().catch(() => false)
console.log(`the offer to keep it: ${offer ? 'shown' : 'not shown'}`)
if (offer) {
  const name = await page.getByTestId('bots-offer-keep-rename').textContent()
  const does = await page.locator('.comet-keep-does').textContent()
  console.log(`  name: ${name}`)
  console.log(`  does: ${does}`)
}
await app.close()
console.log('keep-shot: DONE')
