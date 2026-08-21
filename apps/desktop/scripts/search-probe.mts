// Which search engine actually answers an automated Chrome on this machine.
// Measured: Google serves its robot check (/sorry) on the very first request,
// which is why the courier searches DuckDuckGo instead. Kept so the question
// can be re-measured rather than re-argued.
// Run: pnpm --filter core exec tsx "$PWD/apps/desktop/scripts/search-probe.mts"
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const RESULTS = 8
// Same shape the agent browser parses with.
function parseGoogleResults(html: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = []
  const seen = new Set<string>()
  const anchor = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]{0,400}?<h3[^>]*>([\s\S]*?)<\/h3>/g
  for (const match of html.matchAll(anchor)) {
    const url = match[1]!.replace(/&amp;/g, '&')
    const title = match[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!title || seen.has(url)) continue
    if (/^https?:\/\/(www\.)?google\.[a-z.]+\/(url|search|preferences|advanced_search)/.test(url)) continue
    if (/accounts\.google\.|policies\.google\.|support\.google\.|consent\.google\./.test(url)) continue
    seen.add(url)
    out.push({ url, title })
    if (out.length >= RESULTS) break
  }
  return out
}

const chrome = [
  join(process.env['PROGRAMFILES'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find((p) => existsSync(p))
if (!chrome) {
  console.error('no Chrome found')
  process.exit(1)
}
const profile = await mkdtemp(join(fileURLToPath(new URL('../../../tmp/', import.meta.url)), 'search-probe-'))
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: chrome,
  headless: false,
  viewport: null,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'],
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
await page.goto(`https://www.google.com/search?q=${encodeURIComponent('ai 최신 동향')}&hl=ko`, {
  waitUntil: 'domcontentloaded',
  timeout: 25_000,
})
const html = await page.content()
const found = parseGoogleResults(html)
console.log(`search-probe: landed on ${page.url().slice(0, 80)}`)
console.log(`search-probe: title "${await page.title()}"`)
console.log(`search-probe: parsed ${found.length} result(s)`)
for (const row of found.slice(0, 5)) console.log(`  - ${row.title} — ${row.url.slice(0, 70)}`)
if (found.length === 0) console.log(`search-probe: page head — ${html.replace(/\s+/g, ' ').slice(0, 300)}`)
await ctx.close()
