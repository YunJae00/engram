import type { WebCourier, WebFinding, WebPage } from 'core'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { flog } from './flog.js'

// The errand's hands: the user's own Chrome, driven over CDP by
// playwright-core. Its window is an ordinary window — park it on another
// desktop and it works there alone; it never touches the user's mouse,
// keyboard or focus. A dedicated profile under userData keeps any login the
// user performs in that window across errands, which is the whole answer to
// SSO: the human logs in once, the agent browses logged-in after.

const NAV_TIMEOUT_MS = 25_000
const PAGE_TEXT_CAP = 12_000
const RESULTS_PER_SEARCH = 8
// The browser is heavyweight company for an 8GB machine — it leaves when the
// errand stops using it rather than idling next to the model.
const IDLE_CLOSE_MS = 3 * 60_000
// Below this the browser is the memory somebody else needs — it leaves.
const PRESSURE_CLOSE_FLOOR = 2e9
const LAUNCH_MIN_FREE = 2.5e9

// Text pages only: the page weight is mostly pixels the reader never reads.
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font'])

type Ctx = import('playwright-core').BrowserContext
type Page = import('playwright-core').Page

function chromeCandidates(): string[] {
  if (process.platform === 'darwin')
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(
      (r): r is string => !!r,
    )
    return roots.flatMap((root) => [
      join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ])
  }
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
}

export function findChrome(): string | null {
  return chromeCandidates().find((path) => existsSync(path)) ?? null
}

// A page a machine cannot pass. Pure so the heuristics have a unit test.
export function classifyWall(
  url: string,
  title: string,
  textHead: string,
  hasPasswordField: boolean,
): 'login' | 'captcha' | null {
  const head = `${title}\n${textHead.slice(0, 2_500)}`
  if (/captcha|are you a robot|not a robot|unusual traffic|verify you are human|cloudflare.{0,40}checking/i.test(head))
    return 'captcha'
  if (hasPasswordField) return 'login'
  if (/\/(login|signin|sign-in|sign_in|sso|auth)\b/i.test(new URL(url).pathname)) return 'login'
  return null
}

// DuckDuckGo's HTML endpoint answers plain markup — results are anchors whose
// href tunnels the real url through the uddg param. Pure for its test.
export function parseDuckResults(html: string): WebFinding[] {
  const out: WebFinding[] = []
  const anchor = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  for (const match of html.matchAll(anchor)) {
    const href = match[1]!
    const title = match[2]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const uddg = /[?&]uddg=([^&]+)/.exec(href)?.[1]
    const url = uddg ? decodeURIComponent(uddg) : href.startsWith('http') ? href : null
    if (!url || !/^https?:/.test(url)) continue
    // The ad slots ride the same class with an adurl tunnel — not evidence.
    if (/duckduckgo\.com\/y\.js|ad_domain=/.test(href)) continue
    out.push({ url, title, snippet: '' })
    if (out.length >= RESULTS_PER_SEARCH) break
  }
  return out
}

let context: Ctx | null = null
let opening: Promise<Ctx> | null = null
let workPage: Page | null = null
let idleTimer: NodeJS.Timeout | null = null
let pressureTimer: NodeJS.Timeout | null = null

function armPressureWatch(): void {
  if (pressureTimer) return
  pressureTimer = setInterval(() => {
    if (!context) return
    const free = os.freemem()
    if (free < PRESSURE_CLOSE_FLOOR) {
      flog('agent-browser', `memory pressure (${(free / 1e9).toFixed(1)}GB free) — closing`)
      void closeAgentBrowser({ force: true })
    }
  }, 15_000)
}

// While something owns the window outright — a teach recording, where the
// person is being watched working — an unforced close steps aside. Memory
// pressure and app quit pass force and still take the browser away.
let claimed = false

export function claimAgentBrowser(on: boolean): void {
  claimed = on
}

// A run parked at a login wall does nothing for minutes while the person
// types their password INTO THIS WINDOW. The idle timer cannot be allowed to
// close Chrome under them, so a hold suspends it until the wall is answered.
// Memory pressure still closes the browser: that rule outranks convenience.
let idleHolds = 0

export function holdAgentBrowser(): () => void {
  idleHolds++
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  let released = false
  return () => {
    if (released) return
    released = true
    idleHolds = Math.max(0, idleHolds - 1)
    if (idleHolds === 0) armIdleClose()
  }
}

function armIdleClose(): void {
  if (idleHolds > 0) return
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void closeAgentBrowser(), IDLE_CLOSE_MS)
}

async function ensureContext(): Promise<Ctx> {
  if (context) return context
  if (opening) return opening
  opening = (async () => {
    const executablePath = findChrome()
    if (!executablePath) throw new Error('no Chrome-family browser found — install Google Chrome to run web errands')
    if (os.freemem() < LAUNCH_MIN_FREE)
      throw new Error(`not enough free memory to open the agent browser (${(os.freemem() / 1e9).toFixed(1)}GB free)`)
    const { chromium } = await import('playwright-core')
    const profileDir = join(app.getPath('userData'), 'agent-browser-profile')
    flog('agent-browser', `launching ${executablePath}`)
    const ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      viewport: null,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        // Test harness hook: exposes a CDP endpoint so an e2e run can stand in
        // for the person's hands in the agent window. Never set in production.
        ...(process.env['ENGRAM_AGENT_CDP'] ? [`--remote-debugging-port=${process.env['ENGRAM_AGENT_CDP']}`] : []),
      ],
    })
    await ctx.route('**/*', (route) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort()
      return route.continue()
    })
    // The user closing the agent window by hand must read as "gone", not
    // leave a dead handle every later errand trips over.
    ctx.on('close', () => {
      if (context === ctx) {
        context = null
        workPage = null
      }
      flog('agent-browser', 'closed')
    })
    context = ctx
    armPressureWatch()
    return ctx
  })().finally(() => {
    opening = null
  })
  return opening
}

async function ensurePage(): Promise<Page> {
  const ctx = await ensureContext()
  if (workPage && !workPage.isClosed()) return workPage
  workPage = ctx.pages()[0] ?? (await ctx.newPage())
  return workPage
}

async function readPage(page: Page): Promise<WebPage> {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const { text, hasPasswordField } = await page
    .evaluate(() => {
      const root = document.querySelector('article, main') ?? document.body
      return {
        text: ((root as HTMLElement | null)?.innerText ?? '').replace(/\n{3,}/g, '\n\n'),
        hasPasswordField: document.querySelector('input[type="password"]') !== null,
      }
    })
    .catch(() => ({ text: '', hasPasswordField: false }))
  const wall = classifyWall(url, title, text, hasPasswordField)
  return { url, title, text: text.slice(0, PAGE_TEXT_CAP), ...(wall ? { wall } : {}) }
}

async function withAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) throw new Error('canceled')
  let onAbort: () => void
  const cancel = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('canceled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, cancel])
  } finally {
    signal.removeEventListener('abort', onAbort!)
  }
}

// The courier core's runErrand drives. One browser, one reused tab.
export function agentCourier(): WebCourier {
  return {
    async search(query, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      try {
        await withAbort(
          page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`, {
            waitUntil: 'domcontentloaded',
            timeout: NAV_TIMEOUT_MS,
          }),
          signal,
        )
        await withAbort(page.waitForSelector('a[data-testid="result-title-a"]', { timeout: 8_000 }), signal)
        const found = await withAbort(
          page.evaluate((cap: number) => {
            return Array.from(document.querySelectorAll('a[data-testid="result-title-a"]'))
              .slice(0, cap)
              .map((a) => ({
                url: (a as HTMLAnchorElement).href,
                title: (a.textContent ?? '').trim(),
                snippet: '',
              }))
          }, RESULTS_PER_SEARCH),
          signal,
        )
        armIdleClose()
        if (found.length > 0) return found
      } catch {
        // fall through to the HTML twin
      }
      await withAbort(
        page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          waitUntil: 'domcontentloaded',
          timeout: NAV_TIMEOUT_MS,
        }),
        signal,
      )
      const html = await withAbort(page.content(), signal)
      armIdleClose()
      return parseDuckResults(html)
    },
    async fetchPage(url, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      await withAbort(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), signal)
      // JS-rendered pages paint just after domcontentloaded; a short settle
      // beats waiting for 'load' on ad-heavy pages that never finish.
      await page.waitForTimeout(800)
      const result = await withAbort(readPage(page), signal)
      armIdleClose()
      return result
    },
  }
}

// The recorder drives the same window: it needs the context itself, and the
// tabs open in it, which nothing else outside this module does.
export async function agentContext(): Promise<Ctx> {
  return ensureContext()
}

export function agentPages(): Page[] {
  return context?.pages().filter((one) => !one.isClosed()) ?? []
}

export function agentWorkPage(): Page | null {
  return workPage && !workPage.isClosed() ? workPage : null
}

export function agentBrowserAvailable(): boolean {
  return findChrome() !== null
}

// Low-level access for the routine driver: same browser, same reused tab,
// same idle and pressure lifecycle the courier lives under.
export async function agentPage(signal?: AbortSignal): Promise<Page> {
  const page = await withAbort(ensurePage(), signal)
  armIdleClose()
  return page
}

export function readAgentPage(page: Page, signal?: AbortSignal): Promise<WebPage> {
  armIdleClose()
  return withAbort(readPage(page), signal)
}

export { withAbort as agentAbortable }

// Close is idempotent and never throws: it runs from errand teardown, the
// idle timer and app quit, in any order — including, thanks to those
// fire-and-forget calls, moments AFTER a teach session has opened the window
// the person is being recorded in. A recording session owns the browser, so
// an unforced close steps aside; memory pressure and quit pass force.
export async function closeAgentBrowser(options: { force?: boolean } = {}): Promise<void> {
  if (claimed && !options.force) return
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (pressureTimer) {
    clearInterval(pressureTimer)
    pressureTimer = null
  }
  const held = context ?? (await opening?.catch(() => null)) ?? null
  // Only forget the window this call is actually closing. A teardown that
  // started before a newer session opened its own window would otherwise
  // erase the live one's handle and leave the session driving a ghost.
  if (held === context) {
    context = null
    workPage = null
  }
  if (!held) return
  try {
    await held.close()
  } catch {
    /* already gone */
  }
}
