// What the app feels like to use, in milliseconds: opening a long
// conversation, typing into it, and moving between tabs. No engine is asked
// anything - this is the window's own work, which is what "sluggish" means.
import { _electron as electron } from '@playwright/test'
import { appendBotTurn, createBot, initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/feel-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/feel-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))

// A conversation somebody has actually been having for a while.
const bot = await createBot(paths, { name: 'reader', purpose: 'reads pages' })
const PARAGRAPH = 'This is the kind of answer a comet writes: a few sentences of markdown, a **bold** word, a [link](https://example.test) and a list.\n\n- one\n- two\n- three\n'
for (let i = 0; i < 30; i++) {
  await appendBotTurn(paths, bot.id, { role: 'user', text: `question number ${i} about something that happened` })
  await appendBotTurn(paths, bot.id, { role: 'assistant', text: `## Answer ${i}\n\n${PARAGRAPH.repeat(3)}` })
}

const started = Date.now()
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
console.log(`  first window: ${Date.now() - started}ms`)
await page.waitForTimeout(400)
await page.screenshot({ path: fileURLToPath(new URL('../../../tmp/boot-early.png', import.meta.url)) })
const painted = Date.now()
await page.waitForLoadState('domcontentloaded')
console.log(`  its document: ${Date.now() - painted}ms`)
const shellAt = Date.now()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 60_000 })
console.log(`  shell visible: ${Date.now() - shellAt}ms`)
console.log(`shell on screen: ${Date.now() - started}ms after launch`)
const timing = (await page.evaluate(`(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const rows = performance.getEntriesByType('resource').map((r) => ({ name: String(r.name).split('/').pop(), start: Math.round(r.startTime), ms: Math.round(r.duration) }))
  const started = performance.getEntriesByName('engram-module-start')[0]
  return {
    moduleStart: started ? Math.round(started.startTime) : -1,
    responseEnd: Math.round(nav.responseEnd),
    interactive: Math.round(nav.domInteractive),
    dom: Math.round(nav.domContentLoadedEventEnd),
    load: Math.round(nav.loadEventEnd),
    rows,
  }
})()`)) as { moduleStart: number; responseEnd: number; interactive: number; dom: number; load: number; rows: { name: string; start: number; ms: number }[] }
console.log(`  html in ${timing.responseEnd}ms, our first line at ${timing.moduleStart}ms, interactive ${timing.interactive}ms, ready ${timing.dom}ms, load ${timing.load}ms`)
for (const row of timing.rows) console.log(`    ${row.name}: starts ${row.start}ms, takes ${row.ms}ms`)

await page.evaluate(`(() => {
  window.__long = []
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] })
})()`)

await page.keyboard.press('Control+l')
await page.getByTestId('bots-view').waitFor({ state: 'visible', timeout: 20_000 })

const openAt = Date.now()
await page.getByTestId(`bot-${bot.id}`).click()
await page.locator('.bots-thread .bubble-msg').last().waitFor({ state: 'visible', timeout: 20_000 })
console.log(`a 60-turn conversation opens: ${Date.now() - openAt}ms`)

// Typing: how long the window takes to answer each keystroke.
const box = page.locator('.bots-write textarea')
await box.click()
const typed: number[] = []
for (const ch of 'what did we decide about the release'.split('')) {
  const at = Date.now()
  await box.press(ch === ' ' ? 'Space' : ch)
  typed.push(Date.now() - at)
}
typed.sort((a, b) => a - b)
console.log(`typing: median ${typed[Math.floor(typed.length / 2)]}ms, worst ${typed[typed.length - 1]}ms over ${typed.length} keys`)

// Moving between the tabs, which unmounts and remounts whole views.
const swaps: number[] = []
for (let i = 0; i < 5; i++) {
  let at = Date.now()
  await page.getByTestId('activity-sky').click()
  await page.getByTestId('cosmos-chat').waitFor({ state: 'visible', timeout: 20_000 })
  swaps.push(Date.now() - at)
  at = Date.now()
  await page.getByTestId('activity-bots').click()
  await page.getByTestId('bots-view').waitFor({ state: 'visible', timeout: 20_000 })
  swaps.push(Date.now() - at)
}
swaps.sort((a, b) => a - b)
console.log(`tab swaps: median ${swaps[Math.floor(swaps.length / 2)]}ms, worst ${swaps[swaps.length - 1]}ms`)

const long = (await page.evaluate(`window.__long`)) as number[]
console.log(`long tasks: ${long.length}, ${long.reduce((n, one) => n + one, 0)}ms blocked, worst ${Math.max(0, ...long)}ms`)

await app.close()
console.log('feel-probe: DONE')
