import { expect, test, chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { chooseOption, hoverOn, pressKey, pressOn, scrollPage, typeText } from '../src/main/page-actions.js'
import { readFrames } from '../src/main/page-reader.js'

// The reader and the hands against the ways real pages are built: a control
// drawn inside a shadow root, one inside a frame, a tab whose panel is
// folded, an icon with no words, a select, an endless list, a search form
// that gets and a form that posts, a link that opens a new tab. Real Chrome,
// a local page, no app around it.

let server: Server
let siteUrl: string
let browser: Browser
let page: Page
let posted = 0

const HOME = `<!doctype html><html><head><title>Patterns</title><style>.panel[hidden]{display:none}</style></head><body>
<main>
  <h1>Patterns</h1>
  <form action="/search" method="get"><input name="q" aria-label="Search" placeholder="Search here"/></form>
  <form action="/post" method="post"><textarea name="comment" aria-label="Comment"></textarea><button type="submit">Send</button></form>
  <div role="tablist">
    <button role="tab" aria-selected="true" aria-controls="p1">Domestic</button>
    <button role="tab" aria-selected="false" aria-controls="p2" onclick="document.getElementById('p1').hidden=true;document.getElementById('p2').hidden=false">International</button>
  </div>
  <div id="p1" class="panel">Domestic allowance: 20 kg</div>
  <div id="p2" class="panel" hidden>International allowance: 23 kg per bag</div>
  <button class="btn icon-next" onclick="document.getElementById('week').textContent='week of the 17th'"><svg width="12" height="12"></svg></button>
  <p id="week">week of the 24th</p>
  <select aria-label="Year" onchange="document.getElementById('year').textContent='showing '+this.value"><option>2026</option><option>2025</option></select>
  <p id="year">showing 2026</p>
  <nav><div id="menu" onmouseenter="document.getElementById('sub').hidden=false">Reports</div><div id="sub" hidden><a href="/q3">Q3 report</a></div></nav>
  <a href="/popup" target="_blank">Open elsewhere</a>
  <shadow-box></shadow-box>
  <iframe src="/inner" title="inner" width="400" height="120"></iframe>
  <div id="list" style="height:200px;overflow:auto"><div style="height:1200px">rows 1-40</div></div>
  <div id="tall" style="height:2400px"></div>
  <div id="more">end of page</div>
</main>
<script>
  customElements.define('shadow-box', class extends HTMLElement { connectedCallback() { const root = this.attachShadow({ mode: 'open' }); root.innerHTML = '<p>shadow words here</p><button aria-label="Shadow action" onclick="this.textContent=\\'shadow pressed\\'">*</button>' } })
  window.addEventListener('scroll', () => { if (window.scrollY > 1500 && !document.getElementById('lazy')) { const d = document.createElement('div'); d.id = 'lazy'; d.textContent = 'rows 41-80 loaded'; document.getElementById('more').appendChild(d) } })
</script></body></html>`

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'POST') {
      posted++
      res.end('<html><title>Posted</title><body>posted</body></html>')
      return
    }
    res.setHeader('content-type', 'text/html')
    if (req.url?.startsWith('/search')) res.end(`<html><head><title>Results</title></head><body><main>results for ${new URL(req.url, 'http://x').searchParams.get('q')}</main></body></html>`)
    else if (req.url === '/inner') res.end('<html><head><title>Inner</title></head><body><p>inside the frame</p><a href="/framed" title="Framed link">go</a></body></html>')
    else if (req.url === '/framed') res.end('<html><head><title>Framed</title></head><body>arrived from the frame</body></html>')
    else if (req.url === '/popup') res.end('<html><head><title>Popup</title></head><body>opened in a new tab</body></html>')
    else if (req.url === '/q3') res.end('<html><head><title>Q3</title></head><body>third quarter</body></html>')
    else res.end(HOME)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no site')
  siteUrl = `http://127.0.0.1:${address.port}/`
  browser = await chromium.launch({ channel: 'chrome', headless: true })
})

test.afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test.beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto(siteUrl, { waitUntil: 'domcontentloaded' })
})

test.afterEach(async () => {
  await page.close()
})

test('the reader sees through shadow roots and frames, numbers every control, and keeps folded words apart', async () => {
  const reading = await readFrames(page)
  expect(reading.text).toContain('shadow words here')
  expect(reading.text).toContain('inside the frame')
  expect(reading.text).toContain('Domestic allowance')
  expect(reading.text).not.toContain('International allowance')
  expect(reading.hidden).toContain('International allowance: 23 kg')
  expect(reading.lines.some((line) => /\[tab\] International/.test(line))).toBe(true)
  expect(reading.lines.some((line) => /\(icon: next\)/.test(line))).toBe(true)
  expect(reading.lines.some((line) => /Shadow action/.test(line))).toBe(true)
  expect(reading.lines.some((line) => /Framed link/.test(line))).toBe(true)
  expect(reading.lines.every((line, i) => line.startsWith(`#${i + 1} `))).toBe(true)
})

test('a tab, an icon by its number, a shadow button and a framed link are all pressed', async () => {
  expect(await pressOn(page, 'International')).toEqual({ ok: true })
  expect((await readFrames(page)).text).toContain('International allowance: 23 kg')

  const icon = (await readFrames(page)).lines.find((line) => /\(icon: next\)/.test(line))!
  expect(await pressOn(page, icon.split(' ')[0]!)).toEqual({ ok: true })
  expect((await readFrames(page)).text).toContain('week of the 17th')

  expect(await pressOn(page, 'Shadow action')).toEqual({ ok: true })
  expect((await readFrames(page)).text).toContain('shadow pressed')

  expect(await pressOn(page, 'Framed link')).toEqual({ ok: true })
  await expect.poll(() => page.frames().some((frame) => frame.url().endsWith('/framed'))).toBe(true)
})

test('search boxes take words and Enter; a form that posts is refused, and stays unsent', async () => {
  expect(await typeText(page, 'Search', 'water', true)).toEqual({ ok: true })
  await expect(page).toHaveTitle('Results')
  expect(await page.textContent('main')).toContain('results for water')
  await page.goBack()
  const refused = await typeText(page, 'Comment', 'hello', true)
  expect(refused.ok).toBe(false)
  expect(refused.refused).toContain('post')
  const send = await pressOn(page, 'Send')
  expect(send.refused).toBe('Send')
  expect(posted).toBe(0)
})

test('a select, a hover menu, an endless page and a key', async () => {
  expect(await chooseOption(page, 'Year', '2025')).toEqual({ ok: true })
  expect(await page.textContent('#year')).toBe('showing 2025')

  expect(await hoverOn(page, 'Reports')).toEqual({ ok: true })
  expect((await readFrames(page)).lines.some((line) => /Q3 report/.test(line))).toBe(true)

  expect(await scrollPage(page, 'bottom')).toEqual({ ok: true })
  await expect.poll(async () => (await readFrames(page)).text).toContain('rows 41-80 loaded')

  expect(await pressKey(page, 'Escape')).toEqual({ ok: true })
  expect((await pressKey(page, 'F5')).ok).toBe(false)
})

test('a link that opens a new tab is followed', async () => {
  const [opened] = await Promise.all([page.context().waitForEvent('page'), pressOn(page, 'Open elsewhere')])
  await opened.waitForLoadState('domcontentloaded')
  expect(await opened.title()).toBe('Popup')
})

test('a very large page is read in a moment, not a minute', async () => {
  await page.setContent(
    `<html><body><main>${Array.from({ length: 12_000 }, (_, i) => `<div><span>row ${i}</span>${i % 15 === 0 ? `<button class="icon-more">*</button>` : ''}</div>`).join('')}</main></body></html>`,
  )
  const started = Date.now()
  const reading = await readFrames(page)
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(reading.lines.length).toBeGreaterThan(100)
  const pressed = Date.now()
  expect(await pressOn(page, '#3')).toEqual({ ok: true })
  expect(Date.now() - pressed).toBeLessThan(8_000)
})
