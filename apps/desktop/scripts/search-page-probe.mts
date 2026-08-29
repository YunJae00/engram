// What a search page answers the agent window with: title, a slice of the
// text, and how many outward links it offers. SEARCH_URLS is a
// semicolon-separated list of results-page addresses to try.
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executablePath = process.env['AGENT_PROBE_CHROME'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const urls = (process.env['SEARCH_URLS'] ?? '').split(';').filter(Boolean)
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'search-probe-')), {
  executablePath,
  headless: false,
  chromiumSandbox: true,
  args: ['--window-size=1200,700', '--window-position=-4000,-4000', '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--test-type'],
  ignoreDefaultArgs: ['--enable-automation'],
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
for (const url of urls) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch((err) => console.log('goto failed', String(err).slice(0, 80)))
  await page.waitForTimeout(1500)
  const seen = await page.evaluate(() => {
    const host = location.host
    const links = [...document.querySelectorAll('a[href]')]
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((href) => /^https?:/.test(href) && !href.includes(host))
    return { title: document.title, text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160), outward: new Set(links).size }
  })
  console.log(`${new URL(url).host}: "${seen.title}" outward=${seen.outward} :: ${seen.text}`)
}
await ctx.close()
