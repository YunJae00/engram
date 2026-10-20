import { expect, test, chromium, type Browser, type Page } from '@playwright/test'
import { readFrames } from '../src/main/page-reader.js'

// Pages keep closed popups in the document. Only the one a click would land
// on is read as standing over the page. Real Chrome, a local page.

let browser: Browser
let page: Page

test.beforeAll(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }) })
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

test('the popup in front is read, and stops being read once closed', async () => {
  await page.setContent(`<main>Project list</main>${panel('', 'Choose a project')}`)
  expect((await readFrames(page)).dialog).toContain('Choose a project')
  await page.locator('[role="dialog"]').evaluate((node) => { (node as HTMLElement).style.opacity = '0' })
  expect((await readFrames(page)).dialog).toBe('')
})
