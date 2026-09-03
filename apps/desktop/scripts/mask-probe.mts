// The picture a brain would be shown, of a page with a password field and
// a card number: are those two black, and is the rest of the page intact?
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { maskSecrets } from '../src/main/page-mask.js'

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<html><body style="margin:0;background:#fff">
    <h1 style="margin:20px;font:20px sans-serif">Sign in</h1>
    <input id="u" value="yunjae" style="position:absolute;left:20px;top:80px;width:200px;height:30px">
    <input id="p" type="password" value="hunter2" style="position:absolute;left:20px;top:130px;width:200px;height:30px">
    <input id="c" autocomplete="cc-number" value="4111 1111 1111 1111" style="position:absolute;left:20px;top:180px;width:200px;height:30px">
  </body></html>`)
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 600, height: 300 } })
// The runner names every function with a helper that does not exist in a
// page; the built app has no such helper. Given to the page, for the probe.
await page.addInitScript('window.__name = (f) => f')
await page.goto(`http://127.0.0.1:${port}/`)
const masked = await maskSecrets(page)
const shot = await page.screenshot({ type: 'png' })
await masked.uncover()
const after = await page.evaluate(() => document.querySelectorAll('[data-engram-mask]').length)
// Read pixels back through a fresh page: the PNG decoded on a canvas.
const probe = await browser.newPage()
await probe.addInitScript('window.__name = (f) => f')
await probe.goto('about:blank')
const pixels = (await probe.evaluate(async (b64) => {
  const img = new Image()
  img.src = 'data:image/png;base64,' + b64
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const g = c.getContext('2d')!
  g.drawImage(img, 0, 0)
  const at = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
  return { user: at(120, 95), pass: at(120, 145), card: at(120, 195), title: at(30, 30) }
}, shot.toString('base64'))) as Record<string, number[]>
const black = (p: number[]) => p.every((v) => v < 20)
console.log(`covered ${masked.covered} fields; boxes left behind: ${after}`)
console.log(`password field black: ${black(pixels.pass!) ? 'yes' : 'NO'} · card field black: ${black(pixels.card!) ? 'yes' : 'NO'} · username untouched: ${black(pixels.user!) ? 'NO (blacked)' : 'yes'}`)
await browser.close()
server.close()
console.log('mask-probe: DONE')
