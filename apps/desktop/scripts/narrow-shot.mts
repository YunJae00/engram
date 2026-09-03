// The shell at the width a small display gives it: does a floating notice
// land on the rail's own fold button?
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/narrow-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/narrow-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await createBot(paths, { name: 'Scout', purpose: 'finds things out' })
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 0, width: 880, height: 700 }))
await page.getByTestId('activity-bots').click()
await page.getByTestId('connect-banner').waitFor({ state: 'visible', timeout: 10_000 })
await page.waitForTimeout(400)
const banner = await page.getByTestId('connect-banner').boundingBox()
const close = await page.getByTestId('comets-rail-close').boundingBox()
const overlaps = !!banner && !!close && banner.x < close.x + close.width && close.x < banner.x + banner.width && banner.y < close.y + close.height && close.y < banner.y + banner.height
console.log(`window 880 wide: banner x ${Math.round(banner?.x ?? -1)}–${Math.round((banner?.x ?? 0) + (banner?.width ?? 0))}, rail fold button x ${Math.round(close?.x ?? -1)}–${Math.round((close?.x ?? 0) + (close?.width ?? 0))} → ${overlaps ? 'OVERLAP' : 'clear'}`)
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/narrow-shot.png', import.meta.url)) })
// A hidden window never reports its fonts as ready, so a click here would
// wait forever: the geometry above is the evidence.
await app.close()
