// Which search engine answers an automated Chrome, and what makes the
// difference. Google refuses a plainly-automated browser; this measures
// whether hiding the automation signals (and warming the profile) changes
// that, so the courier's choice of engine rests on evidence.
// Run: pnpm --filter core exec tsx "$PWD/apps/desktop/scripts/search-probe.mts"
import { chromium, type BrowserContext } from 'playwright-core'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const QUERY = 'ai 최신 동향'
const TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))

function countResults(html: string): number {
  const seen = new Set<string>()
  const anchor = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]{0,400}?<h3[^>]*>([\s\S]*?)<\/h3>/g
  for (const m of html.matchAll(anchor)) {
    const url = m[1]!
    if (/google\.[a-z.]+\/(url|search|preferences)|accounts\.google\.|policies\.google\.|consent\.google\./.test(url)) continue
    if (!m[2]!.replace(/<[^>]+>/g, '').trim()) continue
    seen.add(url)
  }
  return seen.size
}

const chrome = [
  join(process.env['PROGRAMFILES'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].find((p) => existsSync(p))
if (!chrome) {
  console.error('no Chrome found')
  process.exit(1)
}

interface Variant {
  name: string
  stealth: boolean
  warm: boolean
  url: (q: string) => string
}

const VARIANTS: Variant[] = [
  { name: 'google plain', stealth: false, warm: false, url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=ko` },
  { name: 'google no-automation-flags', stealth: true, warm: false, url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=ko` },
  { name: 'google stealth + warmed profile', stealth: true, warm: true, url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=ko` },
  { name: 'bing stealth', stealth: true, warm: false, url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { name: 'duckduckgo (what ships)', stealth: false, warm: false, url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web` },
]

for (const variant of VARIANTS) {
  const profile = await mkdtemp(join(TMP, 'search-probe-'))
  let ctx: BrowserContext | null = null
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: chrome,
      headless: false,
      viewport: null,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        ...(variant.stealth ? ['--disable-blink-features=AutomationControlled'] : []),
      ],
      ...(variant.stealth ? { ignoreDefaultArgs: ['--enable-automation'] } : {}),
    })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    if (variant.stealth)
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
      })
    if (variant.warm) {
      await page.goto('https://www.google.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => undefined)
      await page.waitForTimeout(2_500)
    }
    await page.goto(variant.url(QUERY), { waitUntil: 'domcontentloaded', timeout: 25_000 })
    await page.waitForTimeout(1_500)
    const html = await page.content()
    const landed = page.url()
    const blocked = /\/sorry\/|unusual traffic|captcha/i.test(landed + html.slice(0, 3_000))
    const results = /bing\.com/.test(landed)
      ? (html.match(/<h2><a href="http/g) ?? []).length
      : /duckduckgo/.test(landed)
        ? (html.match(/result-title-a|result__a/g) ?? []).length
        : countResults(html)
    console.log(
      `${variant.name.padEnd(32)} ${blocked ? 'BLOCKED' : 'ok     '} results≈${String(results).padStart(3)}  ${landed.slice(0, 60)}`,
    )
  } catch (err) {
    console.log(`${variant.name.padEnd(32)} ERROR   ${String(err).slice(0, 80)}`)
  } finally {
    await ctx?.close().catch(() => undefined)
    await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  }
}
