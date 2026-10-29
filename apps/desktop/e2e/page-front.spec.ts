import { expect, test, chromium, type Browser, type Page } from '@playwright/test'
import { readFrames } from '../src/main/page-reader.js'
import { pressOn, signature } from '../src/main/page-actions.js'

// Pages keep closed popups in the document. Only the one a click would land
// on is read as standing over the page. Real Chrome, a local page.

let browser: Browser
let page: Page

test.beforeAll(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-background-mode'] }) })
test.afterAll(async () => { await browser?.close() })
test.beforeEach(async () => { page = await browser.newPage({ viewport: { width: 1280, height: 800 } }) })
test.afterEach(async () => { await page.close() })

const panel = (style: string, words: string) => `<div role="dialog" style="position:fixed;top:100px;left:100px;width:400px;height:240px;z-index:50;${style}">${words}<button>Close</button></div>`

test('closed popups left in the page are not read as open', async () => {
  await page.setContent(`<main>Project list</main>
    ${panel('opacity:0', 'Faded project picker')}
    ${panel('left:-2000px', 'Parked project picker')}
    ${panel('z-index:1', 'Buried project picker')}<div style="position:fixed;inset:0;z-index:10;background:#fff">Cover</div>`)
  expect((await readFrames(page)).dialog).toBe('')
})

// A panel that names no dialog: entries drawn on top of the page, or a notice.
const lifted = (inner: string) => `<div id="lifted" style="position:absolute;top:120px;left:300px;width:520px;height:360px;z-index:20;background:#fff">${inner}</div>`
const entries = Array.from({ length: 4 }, (_, at) => `<div>${at + 1} hr <button>X</button> Bug fixes <button>New</button></div>`).join('')

test('a board of entries drawn over the page is the page, unless a sheet covers the view behind it', async () => {
  await page.setContent(`<main style="height:1600px">Time Report week</main>${lifted(entries)}`)
  expect((await readFrames(page)).dialog).toBe('')
  await page.setContent(`<main style="height:1600px">Time Report week</main><div style="position:fixed;inset:0;z-index:15;background:rgba(0,0,0,.4)"></div>${lifted(entries)}`)
  expect((await readFrames(page)).dialog).toContain('Bug fixes')
  await page.setContent(`<main style="height:1600px">Time Report week</main>${lifted('Submit the October report by the 31st. <button>OK</button>')}`)
  expect((await readFrames(page)).dialog).toBe('')
})

test('the popup in front is read, and stops being read once closed', async () => {
  await page.setContent(`<main>Project list</main>${panel('', 'Choose a project')}`)
  expect((await readFrames(page)).dialog).toContain('Choose a project')
  await page.locator('[role="dialog"]').evaluate((node) => { (node as HTMLElement).style.opacity = '0' })
  expect((await readFrames(page)).dialog).toBe('')
})

test('checkbox state changes count as progress even when text does not change', async () => {
  await page.setContent('<label><input type="checkbox"> Include archived</label>')
  const before = await signature(page)
  await readFrames(page)
  expect(await pressOn(page, '#1')).toMatchObject({ ok: true, changed: true })
  expect(await signature(page)).not.toBe(before)
  expect(await page.locator('input').isChecked()).toBe(true)
})

test('hidden password fields and floating calendars do not block a readable page', async () => {
  await page.setContent(`<main>Report total: 393</main><input type="password" style="display:none">${lifted('October calendar <button>Next month</button>')}`)
  expect(await readFrames(page)).toMatchObject({ hasPasswordField: false, dialog: '' })
  await page.locator('input').evaluate(el => { (el as HTMLElement).style.display = 'block' })
  expect((await readFrames(page)).hasPasswordField).toBe(true)
})

test('an unrelated iframe navigation does not invalidate main-document controls', async () => {
  await page.setContent('<button onclick="this.textContent=\'Opened\'">Details</button><iframe srcdoc="Ad"></iframe>')
  await readFrames(page)
  await page.locator('iframe').evaluate(el => { (el as HTMLIFrameElement).srcdoc = 'New ad' })
  await expect(page.frameLocator('iframe').locator('body')).toHaveText('New ad')
  expect(await pressOn(page, '#1')).toMatchObject({ ok: true })
  await expect(page.locator('button')).toHaveText('Opened')
})
