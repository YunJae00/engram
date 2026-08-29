// Opens the agent window the way the app does and reports what a page can
// tell about it (the webdriver flag), holding it on screen for a capture.
// AGENT_PROBE_DROP lists default driver switches to leave out, semicolon-separated.
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executablePath = process.env['AGENT_PROBE_CHROME'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const drop = (process.env['AGENT_PROBE_DROP'] ?? '').split(';').filter(Boolean)
const extra = (process.env['AGENT_PROBE_ARGS'] ?? '').split(';').filter(Boolean)
const profileDir = process.env['AGENT_PROBE_PROFILE'] ?? mkdtempSync(join(tmpdir(), 'agent-window-probe-'))
const ctx = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: false,
  chromiumSandbox: true,
  viewport: { width: 1200, height: 700 },
  args: ['--window-size=1200,700', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', ...extra],
  ignoreDefaultArgs: ['--enable-automation', ...drop],
})
await ctx.addInitScript(() => {
  ;(window as unknown as { __probe: number }).__probe = 1
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true })
})
const page = ctx.pages()[0] ?? (await ctx.newPage())
if (process.env['AGENT_PROBE_CDP_OFF']) {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setAutomationOverride', { enabled: false })
}
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => undefined)
console.log('webdriver', await page.evaluate(() => ({ webdriver: navigator.webdriver, probe: (window as unknown as { __probe?: number }).__probe, own: Object.getOwnPropertyNames(navigator), proto: String(Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')?.get), configurable: Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')?.configurable })))
console.log('open', process.pid)
await new Promise((resolve) => setTimeout(resolve, Number(process.env['AGENT_PROBE_HOLD_MS'] ?? 6000)))
await ctx.close()
