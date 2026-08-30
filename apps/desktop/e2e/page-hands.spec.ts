import { expect, test, chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { chooseOption, hoverOn, pressKey, pressOn, pressPoint, scrollPage, typeText } from '../src/main/page-actions.js'
import { revealText } from '../src/main/page-reveal.js'
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
  expect(await pressOn(page, 'International')).toMatchObject({ ok: true })
  expect((await readFrames(page)).text).toContain('International allowance: 23 kg')

  const icon = (await readFrames(page)).lines.find((line) => /\(icon: next\)/.test(line))!
  expect(await pressOn(page, icon.split(' ')[0]!)).toMatchObject({ ok: true })
  expect((await readFrames(page)).text).toContain('week of the 17th')

  expect(await pressOn(page, 'Shadow action')).toMatchObject({ ok: true })
  expect((await readFrames(page)).text).toContain('shadow pressed')

  expect(await pressOn(page, 'Framed link')).toMatchObject({ ok: true })
  await expect.poll(() => page.frames().some((frame) => frame.url().endsWith('/framed'))).toBe(true)
})

test('search boxes take words and Enter; a form that posts is refused, and stays unsent', async () => {
  expect(await typeText(page, 'Search', 'water', true)).toMatchObject({ ok: true })
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
  expect(await chooseOption(page, 'Year', '2025')).toMatchObject({ ok: true })
  expect(await page.textContent('#year')).toBe('showing 2025')

  expect(await hoverOn(page, 'Reports')).toMatchObject({ ok: true })
  expect((await readFrames(page)).lines.some((line) => /Q3 report/.test(line))).toBe(true)

  expect(await scrollPage(page, 'bottom')).toMatchObject({ ok: true })
  await expect.poll(async () => (await readFrames(page)).text).toContain('rows 41-80 loaded')

  expect(await pressKey(page, 'Escape')).toMatchObject({ ok: true })
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
  expect(await pressOn(page, '#3')).toMatchObject({ ok: true })
  expect(Date.now() - pressed).toBeLessThan(8_000)
})

test('a day cell that only the pointer marks as pressable is numbered, and pressing it lands there', async () => {
  // The shape a framework leaves behind: one listener on the table, cells
  // that declare nothing, and the same short words higher up the page.
  await page.setContent(`<html><head><style>#cal td.day{cursor:pointer}</style></head><body><main>
    <table id="week"><tr><td>Wed 8.26</td><td>3 Units / 13 hr</td><td>13</td></tr></table>
    <table id="cal"><tbody><tr>${[11, 12, 13, 14].map((n) => `<td class="day"> <span>${n}</span> </td>`).join('')}</tr></tbody></table>
    <p id="picked">picked: none</p></main>
    <script>
      document.getElementById('cal').addEventListener('click', (e) => {
        const cell = e.target.closest('td.day')
        if (cell) document.getElementById('picked').textContent = 'picked: ' + cell.textContent.trim()
      })
    </script></body></html>`)
  const day = (await readFrames(page)).lines.find((line) => /\[clickable\] 13$/.test(line))
  expect(day).toBeTruthy()
  expect(await pressOn(page, day!.split(' ')[0]!)).toMatchObject({ ok: true })
  expect(await page.textContent('#picked')).toBe('picked: 13')
})

test('the same words in two places are refused with the numbers to choose from, and a press that changes nothing says so', async () => {
  await page.setContent(`<html><head><style>#cal td{cursor:pointer}</style></head><body><main>
    <table id="week"><tr><td>Wed</td><td>13</td></tr></table>
    <table id="cal"><tbody><tr><td> <span>13</span> </td><td> <span>14</span> </td></tr></tbody></table>
    <button id="inert">Inert</button></main></body></html>`)
  const refused = await pressOn(page, '13')
  expect(refused.ok).toBe(false)
  expect(refused.error).toContain('more than one place')
  expect(refused.error).toMatch(/#\d+/)

  // A button that does nothing is pressed all the same — and reported as
  // having changed nothing, so a wrong guess is visible.
  const inert = await pressOn(page, 'Inert')
  expect(inert.ok).toBe(true)
  expect(inert.changed).toBe(false)
})

test('a point on the picture is pressed where a name cannot reach, and a commit under the point is still refused', async () => {
  await page.setContent(`<html><body style="margin:0"><main>
    <canvas id="board" width="600" height="300" style="display:block"></canvas>
    <form action="/post" method="post"><button type="submit" style="width:200px;height:60px">Send</button></form>
    <p id="picked">picked: none</p></main>
    <script>
      document.getElementById('board').addEventListener('click', (e) => {
        const r = e.target.getBoundingClientRect()
        document.getElementById('picked').textContent = 'canvas at ' + Math.round(e.clientX - r.left) + ',' + Math.round(e.clientY - r.top)
      })
    </script></body></html>`)
  // Nothing on a canvas has a name or a number; the point is all there is.
  const board = (await page.locator('#board').boundingBox())!
  const size = page.viewportSize()!
  const drawn = await pressPoint(page, (board.x + board.width * 0.5) / size.width, (board.y + board.height * 0.5) / size.height)
  expect(drawn).toMatchObject({ ok: true, changed: true })
  expect(await page.textContent('#picked')).toMatch(/^canvas at 30[0-9],1[45][0-9]$/)

  const send = (await page.locator('button[type="submit"]').boundingBox())!
  const refused = await pressPoint(page, (send.x + send.width / 2) / size.width, (send.y + send.height / 2) / size.height)
  expect(refused.ok).toBe(false)
  expect(refused.refused).toBe('Send')
  expect(posted).toBe(0)

  expect((await pressPoint(page, 1.4, 0.2)).error).toContain('fractions')
})

test('a folded section is opened by the words inside it, and a view toggle is not mistaken for a payment', async () => {
  await page.setContent(`<html><body><main>
    <details><summary>Browser compatibility</summary><table><tr><td>Chrome 37</td></tr></table></details>
    <div><button aria-expanded="false" aria-controls="fold" onclick="const f=document.getElementById('fold');f.hidden=!f.hidden;this.setAttribute('aria-expanded',String(!f.hidden))">More detail</button>
      <div id="fold" hidden><p>the quarterly figure is 4410</p></div></div>
    <button role="switch" aria-checked="false">월간 결제</button>
    <p id="mode">yearly</p>
    <script>document.querySelector('[role=switch]').addEventListener('click', () => { document.getElementById('mode').textContent = 'monthly' })</script>
  </main></body></html>`)
  // What a page keeps out of sight is named in the reading, and opened by
  // asking for the words themselves.
  expect((await readFrames(page)).hidden).toContain('4410')
  const opened = await revealText(page, '4410')
  expect(opened).toMatchObject({ ok: true, changed: true })
  expect(opened.opened).toContain('More detail')
  await expect.poll(async () => (await readFrames(page)).text).toContain('4410')

  expect(await revealText(page, 'Chrome 37')).toMatchObject({ ok: true })
  await expect.poll(async () => (await readFrames(page)).text).toContain('Chrome 37')

  // A switch says what it does: it changes the view, so its words do not
  // make it a payment.
  expect(await pressOn(page, '월간 결제')).toMatchObject({ ok: true })
  expect(await page.textContent('#mode')).toBe('monthly')
})
