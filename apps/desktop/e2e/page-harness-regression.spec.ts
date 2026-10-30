import { expect, test, chromium, type Browser, type Page } from '@playwright/test'
import { handOn, pressKey } from '../src/main/page-actions.js'
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
