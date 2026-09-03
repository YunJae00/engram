// A person's own hands on the mirrored page: does a click land where the
// picture shows it, and does typing reach the page? A local page answers
// both by navigating: a full-page link, and a box that goes where you
// typed on Enter.
import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (req.url?.startsWith('/type')) {
    res.end('<html><body style="margin:0"><input id="t" autofocus style="position:fixed;inset:0;width:100%;height:100%;font-size:40px" onkeydown="if(event.key===\'Enter\')location=\'/typed?\'+encodeURIComponent(this.value)"></body></html>')
    return
  }
  res.end(`<html><body style="margin:0"><a href="/clicked" style="position:fixed;inset:0;background:#eef"></a><div style="position:fixed;left:0;top:0;padding:8px">${req.url}</div></body></html>`)
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

const VAULT = fileURLToPath(new URL('../../../tmp/hands-vault/', import.meta.url))
const USERDATA = fileURLToPath(new URL('../../../tmp/hands-userdata/', import.meta.url))
await rm(VAULT, { recursive: true, force: true })
await rm(USERDATA, { recursive: true, force: true })
const paths = await initVault(VAULT, { git: false })
await mkdir(USERDATA, { recursive: true })
await writeFile(join(USERDATA, 'settings.json'), JSON.stringify({ defaultEngine: 'claude', autoStart: false, teamSync: 'auto' }))
const bot = await createBot(paths, { name: 'hands', purpose: 'a page to press' })
const app = await electron.launch({
  args: [fileURLToPath(new URL('../out/main/index.js', import.meta.url)), '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: VAULT, ENGRAM_USERDATA: USERDATA, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none' },
})
const page = await app.firstWindow()
await page.getByTestId('shell').waitFor({ state: 'visible', timeout: 40_000 })
await page.getByTestId(`bot-${bot.id}`).click()
await page.evaluate((url) => window.engram.agentGo(url), `${base}/start`)
await page.getByTestId('web-pane').waitFor({ state: 'visible', timeout: 30_000 })
// How the picture's shape settles against the stage, second by second.
for (let i = 1; i <= 6; i++) {
  await page.waitForTimeout(1_000)
  const shape = await page.evaluate(() => {
    const c = document.querySelector('.mirror-screen canvas') as HTMLCanvasElement | null
    const stage = document.querySelector('.web-pane-stage')?.getBoundingClientRect()
    return `canvas ${c?.width}x${c?.height} in stage ${Math.round(stage?.width ?? 0)}x${Math.round(stage?.height ?? 0)}`
  })
  console.log(`  ${i}s: ${shape}`)
}
const canvas = page.locator('.mirror-screen canvas')
const box = await canvas.boundingBox()
if (!box) throw new Error('no picture')
// A press near the picture's corner: the band, if any, is where a mapping
// against the box would go wrong.
// Asked by hand: does the page take the height at all?
await page.evaluate(() => window.engram.agentHeight(1620))
await page.waitForTimeout(2_500)
console.log(`  after asking for 1620 by hand: ${await page.evaluate(() => { const c = document.querySelector('.mirror-screen canvas') as HTMLCanvasElement | null; return `canvas ${c?.width}x${c?.height}` })}`)
await page.evaluate(() => window.engram.agentRefresh())
await page.waitForTimeout(2_500)
console.log(`  after a refresh by hand: ${await page.evaluate(() => { const c = document.querySelector('.mirror-screen canvas') as HTMLCanvasElement | null; return `canvas ${c?.width}x${c?.height}` })} · state ${JSON.stringify(await page.evaluate(() => window.engram.agentState()))}`)
const live = await page.evaluate(() => (document.querySelector('.web-pane') ? 'pane' : 'no pane') + ' / canvas ' + (document.querySelector('.mirror-screen canvas') as HTMLCanvasElement | null)?.width + 'x' + (document.querySelector('.mirror-screen canvas') as HTMLCanvasElement | null)?.height)
console.log(`before the click: ${live}, box ${Math.round(box.width)}x${Math.round(box.height)}`)
await page.mouse.click(box.x + box.width * 0.08, box.y + box.height * 0.92)
await page.waitForTimeout(1_500)
const afterClick = ((await page.evaluate(() => window.engram.agentState())) as { url?: string }).url ?? ''
console.log(`a click on the picture: ${afterClick.endsWith('/clicked') ? 'landed' : 'MISSED'} (${afterClick})`)
if (!afterClick.endsWith('/clicked')) {
  // The same press sent straight down the wire, past the canvas.
  await page.evaluate(() => window.engram.agentInput({ kind: 'mouse', type: 'pressed', x: 0.5, y: 0.5, button: 'left', clicks: 1, modifiers: 0 }))
  await page.evaluate(() => window.engram.agentInput({ kind: 'mouse', type: 'released', x: 0.5, y: 0.5, button: 'left', clicks: 1, modifiers: 0 }))
  await page.waitForTimeout(1_500)
  const direct = ((await page.evaluate(() => window.engram.agentState())) as { url?: string }).url ?? ''
  console.log(`the same press sent directly: ${direct.endsWith('/clicked') ? 'landed' : 'MISSED'} (${direct})`)
}

await page.evaluate((url) => window.engram.agentGo(url), `${base}/type`)
await page.waitForTimeout(2_000)
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
await page.keyboard.type('hello there', { delay: 30 })
await page.keyboard.press('Enter')
await page.waitForTimeout(1_500)
const afterType = ((await page.evaluate(() => window.engram.agentState())) as { url?: string }).url ?? ''
console.log(`typing on the picture: ${decodeURIComponent(afterType).endsWith('/typed?hello there') ? 'reached the page' : 'LOST'} (${decodeURIComponent(afterType)})`)
await app.close()
server.close()
console.log('hands-probe: DONE')
