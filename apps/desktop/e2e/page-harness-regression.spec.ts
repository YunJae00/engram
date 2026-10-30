import { expect, test, chromium, type Browser, type Page } from '@playwright/test'
import { handOn, pressKey, pressOn } from '../src/main/page-actions.js'
import { readFrames } from '../src/main/page-reader.js'

let browser: Browser
let page: Page
test.beforeAll(async () => { browser = await chromium.launch({ channel: 'chrome', headless: true }) })
test.afterAll(async () => { await browser?.close() })
test.beforeEach(async () => { page = await browser.newPage() })
test.afterEach(async () => { await page.close() })

test('clears stale hand marks before numbering and choosing a control', async () => {
  await page.setContent('<button data-engram-hand>Old</button><button>New</button><div id="shadow"></div>')
  await page.locator('#shadow').evaluate(el => { el.attachShadow({ mode: 'open' }).innerHTML = '<button data-engram-hand>Shadow</button>' })
  const read = await readFrames(page)
  expect(await page.locator('[data-engram-hand]').count()).toBe(0)
  const number = /^#\d+/.exec(read.lines.find(line => line.includes('New'))!)![0]
  await page.locator('button').first().evaluate(el => el.setAttribute('data-engram-hand', 'stale'))
  const aim = await handOn(page, number)
  expect('hand' in aim && await aim.hand.innerText()).toBe('New')
  expect(await page.locator('[data-engram-hand]').count()).toBe(1)
})

test('approves contenteditable Enter exactly once and records the dispatch', async () => {
  await page.setContent('<div contenteditable="true" aria-label="Message">Hello</div><output>0</output>')
  await page.locator('[contenteditable]').evaluate(el => el.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key === 'Enter') { event.preventDefault(); document.querySelector('output')!.textContent = String(Number(document.querySelector('output')!.textContent) + 1) }
  }))
  await page.locator('[contenteditable]').focus()
  expect((await pressKey(page, 'Enter')).ok).toBe(false)
  await expect(page.locator('output')).toHaveText('0')
  expect(await pressKey(page, 'Enter', undefined, async () => 'approve')).toMatchObject({ ok: true, committed: true })
  await expect(page.locator('output')).toHaveText('1')
})


test('retains late calendar cards beyond the old control cap with stable numbered targets', async () => {
  await page.setContent(Array.from({ length: 300 }, (_, i) => `<button>Earlier ${i}</button>`).join('') + '<section aria-label="October 30"><div role="button" tabindex="0">Training 17:00</div></section>')
  const read = await readFrames(page)
  const card = read.lines.find(line => line.includes('Training 17:00'))
  expect(card).toContain('October 30')
  const aim = await handOn(page, /^#\d+/.exec(card!)![0])
  expect('hand' in aim && await aim.hand.innerText()).toBe('Training 17:00')
})


test('uses the approval callback for downloads and does not click after denial', async () => {
  await page.setContent(`<button onclick="this.textContent='Downloaded'">Download report</button>`)
  let approvals = 0
  const result = await pressOn(page, 'Download report', undefined, async () => { approvals++; return 'cancel' })
  expect(approvals).toBe(1)
  expect(result.ok).toBe(false)
  await expect(page.getByRole('button')).toHaveText('Download report')
})
