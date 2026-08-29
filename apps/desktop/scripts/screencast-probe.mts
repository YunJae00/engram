// Does a window parked off the screen still paint? The live view inside the
// app depends on frames arriving from a window nobody sees. Counts the
// frames a screencast delivers in a few seconds, on screen and off.
import { chromium } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executablePath = process.env['AGENT_PROBE_CHROME'] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
for (const position of ['120,80', '-4000,-4000']) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'screencast-probe-')), {
    executablePath,
    headless: false,
    chromiumSandbox: true,
    viewport: { width: 1200, height: 700 },
    args: ['--window-size=1200,700', `--window-position=${position}`, '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled', '--test-type'],
    ignoreDefaultArgs: ['--enable-automation'],
  })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => undefined)
  const cdp = await ctx.newCDPSession(page)
  let frames = 0
  let bytes = 0
  cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
    frames++
    bytes += frame.data.length
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 })
  // Something to paint: the page scrolls itself a little every second.
  for (let i = 0; i < 5; i++) {
    await page.evaluate((n) => {
      document.body.style.paddingTop = `${n * 10}px`
    }, i)
    await page.waitForTimeout(1_000)
  }
  await cdp.send('Page.stopScreencast').catch(() => undefined)
  console.log(`window at ${position}: ${frames} frames in 5s, ${(bytes / Math.max(1, frames) / 1024).toFixed(0)}KB each`)
  await ctx.close()
}
