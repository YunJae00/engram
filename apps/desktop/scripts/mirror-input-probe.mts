import { _electron as electron } from '@playwright/test'
import { createBot, initVault } from 'core'
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const MAIN_ENTRY = fileURLToPath(new URL('../out/main/index.js', import.meta.url))

await mkdir(REPO_TMP, { recursive: true })
const root = await mkdtemp(join(REPO_TMP, 'probe-input-'))
const userData = await mkdtemp(join(REPO_TMP, 'probe-input-ud-'))
const paths = await initVault(root, { git: false })
await createBot(paths, { name: 'Watching', purpose: '' })

const seen: string[] = []
const server = createServer((req, res) => {
  if (req.url?.startsWith('/log')) {
    seen.push(decodeURIComponent(req.url.slice(5)))
    res.end('ok')
    return
  }
  if (req.url?.startsWith('/typed')) {
    seen.push(`NAVIGATED ${req.url}`)
    res.setHeader('content-type', 'text/html')
    res.end('<html><body><h1>Typed</h1></body></html>')
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end(
    '<html><body><h1>Echo</h1>' +
      '<form action="/typed"><input name="q" aria-label="Query" style="position:fixed;left:0;top:0;width:100%;height:40%;font-size:40px"/></form>' +
      '<script>' +
      'const say=(m)=>fetch("/log?"+encodeURIComponent(m));' +
      'addEventListener("pointerdown",(e)=>say("down "+Math.round(e.clientX)+","+Math.round(e.clientY)+" on "+e.target.tagName));' +
      'addEventListener("keydown",(e)=>say("key "+e.key+" focus "+document.activeElement.tagName));' +
      '</script></body></html>',
  )
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const address = server.address() as { port: number }
const siteUrl = `http://127.0.0.1:${address.port}/`

const app = await electron.launch({
  args: [MAIN_ENTRY, '--no-sandbox'],
  env: { ...process.env, ENGRAM_VAULT: root, ENGRAM_USERDATA: userData, ENGRAM_NO_GIT: '1', ENGRAM_NO_AUTOTIDY: '1', ENGRAM_ENGINE: 'none', ENGRAM_HIDDEN: '1' },
})
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 160)))
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 160)) })
await page.waitForSelector('[data-testid="shell"]', { timeout: 60000 })
await page.evaluate(async () => {
  const installed = (await window.engram.browsersInstalled()) as { path: string }[]
  if (installed[0]) await window.engram.browserChoose(installed[0].path)
})
await page.getByTestId('activity-bots').click()
await page.locator('.bots-row', { hasText: 'Watching' }).click()
await page.evaluate(() => window.engram.agentWatch(true))
await page.evaluate((url) => window.engram.agentGo(url), siteUrl)
await page.getByTestId('web-pane').waitFor({ timeout: 60000 })
await page.getByTestId('live-address').fill(siteUrl)
await page.getByTestId('live-address').press('Enter')
const stage = page.getByTestId('web-pane').locator('.mirror-surface')
await stage.locator('canvas').waitFor({ timeout: 15000 })
await new Promise((r) => setTimeout(r, 2000))

await page.evaluate(() => {
  const real = window.engram.agentInput.bind(window.engram)
  const log: string[] = []
  ;(window as unknown as { __sent: string[] }).__sent = log
  window.engram.agentInput = (input: Parameters<typeof real>[0]) => {
    log.push(input.kind === 'mouse' ? `${input.kind}:${input.type}@${input.x.toFixed(2)},${input.y.toFixed(2)}` : `${input.kind}`)
    return real(input)
  }
})
for (let round = 1; round <= 3; round++) {
  await page.evaluate((url) => window.engram.agentGo(url), siteUrl)
  await stage.locator('canvas[data-painted]').waitFor({ timeout: 15000 })
  await new Promise((r) => setTimeout(r, 700))
  seen.length = 0
  await page.evaluate(() => { (window as unknown as { __sent: string[] }).__sent.length = 0 })
  const screen = stage.locator('canvas')
  const box = (await screen.boundingBox())!
  await screen.click({ position: { x: box.width / 2, y: box.height * 0.2 } })
  await page.keyboard.type('hello')
  await page.keyboard.press('Enter')
  await new Promise((r) => setTimeout(r, 3000))
  const sent = (await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent.join(' | '))) as string
  console.log(`round ${round} renderer sent:`, sent)
  console.log(`round ${round} page saw:`, seen.length ? seen.join(' | ') : 'NOTHING')
}

await app.close()
server.close()
console.log('probe done')
