// The comet's hand on the picture: a turn that presses something, and a
// screenshot the moment the pointer is announced.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/pointer-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/pointer-userdata/', import.meta.url))
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
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
for (let i = 0; i < 30; i++) {
  const engines = (await page.evaluate(() => window.engram.engines())) as { id: string }[]
  if (engines.some((e) => e.id === 'claude')) break
  await page.waitForTimeout(2_000)
}
let pointers = 0
let done = false
await page.exposeFunction('__pointer', () => {
  pointers++
})
await page.exposeFunction('__done', () => {
  done = true
})
const steps: string[] = []
await page.exposeFunction('__step', (line: string) => {
  steps.push(line)
})
await page.evaluate(`window.engram.onEvent((e) => { if (e.type === 'agent:pointer') window.__pointer(); if (e.type === 'comet:step') window.__step(e.line); if (e.type === 'chat:done' || e.type === 'chat:error') window.__done() })`)
await page.getByTestId(`bot-${bot.id}`).click()
const box = page.locator('.bots-write textarea')
await box.click()
await box.fill('open https://en.wikipedia.org/wiki/Seoul, press the "Talk" tab at the top, then press the "View history" tab, and tell me the title of the page you end on')
await box.press('Enter')
let shot = false
for (let i = 0; i < 150 && !done; i++) {
  if (!shot && pointers > 0) {
    await page.waitForTimeout(350)
    await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/pointer-shot.png', import.meta.url)) })
    shot = true
    // The person puts a hand on the page mid-turn: a press on the page's
    // margin. The comet should step aside, then carry on once still.
    await page.evaluate(() => window.engram.agentInput({ kind: 'mouse', type: 'pressed', x: 0.985, y: 0.985, button: 'left', clicks: 1, modifiers: 0 }))
    await page.evaluate(() => window.engram.agentInput({ kind: 'mouse', type: 'released', x: 0.985, y: 0.985, button: 'left', clicks: 1, modifiers: 0 }))
  }
  await page.waitForTimeout(1_000)
}
console.log(`pointer events during the turn: ${pointers} · screenshot: ${shot ? 'taken' : 'none'}`)
const ghost = await page.getByTestId('hand-ghost').count()
console.log(`hand ghost in the DOM at the end: ${ghost}`)
console.log(`stepped aside: ${steps.some((l) => l.startsWith('aside:')) ? 'yes' : 'NO'} · carried on: ${steps.some((l) => l.startsWith('resume:')) ? 'yes' : 'NO'}`)
console.log(`  steps: ${steps.map((l) => l.split(':')[0]).join(' → ')}`)
await app.close()
console.log('pointer-shot: DONE')
