// What the mirror actually carries: the size of a streamed frame, the size of
// the still the large view asks for, and how many kilobytes each costs.
// Read-only - it opens one public page and looks at it.
import { _electron as electron } from '@playwright/test'
import { initVault } from 'core'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const VAULT = fileURLToPath(new URL('../../../tmp/mirror-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/mirror-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))

const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })

await page.evaluate(`(() => {
  window.__seen = []
  window.engram.onEvent((e) => {
    if (e.type !== 'agent:frame') return
    const at = window.__seen.length
    window.__seen.push({ w: e.width, h: e.height, kb: Math.round(e.data.length * 0.75 / 1024), px: '?' })
    const raw = atob(e.data)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then((b) => { window.__seen[at].px = b.width + 'x' + b.height; b.close() })
  })
})()`)
await page.evaluate(() => window.engram.agentWatch(true))
await page.evaluate(() => window.engram.agentGo('https://en.wikipedia.org/wiki/Cartography'))
await page.waitForTimeout(9_000)
const streamed = (await page.evaluate(`window.__seen`)) as { w: number; h: number; kb: number; px: string }[]
console.log(`streamed frames: ${streamed.length}`)
for (const one of streamed.slice(0, 3)) console.log(`  said ${one.w}x${one.h}, really ${one.px}, ${one.kb}KB`)

await page.evaluate(`window.__seen = []`)
await page.evaluate(() => window.engram.agentRefresh(true))
await page.waitForTimeout(4_000)
const sharp = (await page.evaluate(`window.__seen`)) as { w: number; h: number; kb: number; px: string }[]
console.log(`the large view's still: ${sharp.map((one) => `${one.px} ${one.kb}KB`).join(', ') || '(none)'}`)


// The pane says it is tall: the page should lay itself out to fit it.
await page.evaluate(`window.__seen = []`)
await page.evaluate(() => window.engram.agentHeight(1500))
await page.waitForTimeout(1_500)
await page.evaluate(() => window.engram.agentRefresh())
await page.waitForTimeout(3_000)
const tall = (await page.evaluate(`window.__seen`)) as { w: number; h: number; kb: number; px: string }[]
console.log(`after asking for a 1280x1500 page: ${tall.map((one) => `${one.w}x${one.h} (${one.px})`).join(', ') || '(no frame)'}`)

await app.close()
console.log('mirror-probe: DONE')
