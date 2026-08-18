import type { WebCourier, WebFinding, WebPage } from 'core'
import { app } from 'electron'
import { existsSync } from 'node:fs'
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

function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => void closeAgentBrowser(), IDLE_CLOSE_MS)
}

async function ensureContext(): Promise<Ctx> {
  if (context) return context
  if (opening) return opening
  opening = (async () => {
    const executablePath = findChrome()
    if (!executablePath) throw new Error('no Chrome-family browser found — install Google Chrome to run web errands')
    const { chromium } = await import('playwright-core')
    const profileDir = join(app.getPath('userData'), 'agent-browser-profile')
    flog('agent-browser', `launching ${executablePath}`)
    const ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      viewport: null,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'],
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

export function agentBrowserAvailable(): boolean {
  return findChrome() !== null
}

// Close is idempotent and never throws: it runs from errand teardown, the
// idle timer and app quit, in any order.
export async function closeAgentBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const held = context ?? (await opening?.catch(() => null)) ?? null
  context = null
  workPage = null
  if (!held) return
  try {
    await held.close()
  } catch {
    /* already gone */
  }
}
