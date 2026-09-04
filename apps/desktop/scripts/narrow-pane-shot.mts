// The comets tab at a small window, pane open and folded: what the fold
// area looks like when there is little room.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
const VAULT = fileURLToPath(new URL('../../../tmp/narrowpane-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/narrowpane-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
const bot = await createBot(paths, { name: 'reader', purpose: 'reads pages' })
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 0, y: 0, width: 980, height: 660 }))
await page.getByTestId(`bot-${bot.id}`).click()
await page.evaluate(() => window.engram.agentGo('https://example.com/'))
await page.getByTestId('web-pane').waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(2_500)
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/narrow-open.png', import.meta.url)) })
const grid = (await page.evaluate(`(() => {
  const r = (sel) => {
    const b = document.querySelector(sel)?.getBoundingClientRect()
    return b ? Math.round(b.width) + 'x' + Math.round(b.height) + '@' + Math.round(b.x) + ',' + Math.round(b.y) : 'none'
  }
  return 'chat ' + r('.bots-chat') + ' · pane ' + r('.web-pane') + ' · stage ' + r('.web-pane-stage') + ' · canvas ' + r('.mirror-screen canvas')
})()`)) as string
console.log('open:', grid)
await page.getByTestId('web-pane-fold').click()
await page.waitForTimeout(600)
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/narrow-folded.png', import.meta.url)) })
console.log('folded:', await page.evaluate(`(() => {
  const b = document.querySelector('[data-testid="web-pane-folded"]')?.getBoundingClientRect()
  return b ? Math.round(b.width) + 'x' + Math.round(b.height) + '@' + Math.round(b.x) + ',' + Math.round(b.y) : 'none'
})()`))
await app.close()
console.log('narrow-pane-shot: DONE')
