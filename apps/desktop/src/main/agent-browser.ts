import type { WebCourier, WebPage } from 'core'
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { autoImportSession } from './browser-import.js'
import { flog } from './flog.js'
import { releaseModelForRoom, setRoomMaker } from './local-llm.js'
import { reserveRoom, ROOM_FOR_BROWSER } from './memory-plan.js'
import { routineDriver } from './routine-driver.js'

// The errand's hands: the user's own Chrome, driven over CDP by
// playwright-core. Its window is an ordinary window — park it on another
// desktop and it works there alone; it never touches the user's mouse,
// keyboard or focus. A dedicated profile under userData keeps any login the
// user performs in that window across errands, which is the whole answer to
// SSO: the human logs in once, the agent browses logged-in after.

const NAV_TIMEOUT_MS = 25_000
const PAGE_TEXT_CAP = 12_000
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

export interface InstalledBrowser {
  id: string
  name: string
  path: string
}

// Which browsers are actually on this machine. Named from the executable so
// nothing here decides that a person "uses Chrome" - what they have is what
// they are offered, and which of them drives the work is theirs to say.
export function installedBrowsers(): InstalledBrowser[] {
  // One entry per browser, not per path: a Linux install answers to several
  // names for the same binary (google-chrome, google-chrome-stable) and a
  // person offered "Google Chrome" twice has been handed a bug, not a choice.
  const seen = new Set<string>()
  const found: InstalledBrowser[] = []
  for (const path of chromeCandidates()) {
    if (!existsSync(path)) continue
    const name = browserName(path)
    if (seen.has(name)) continue
    seen.add(name)
    found.push({ id: path, name, path })
  }
  return found
}

function browserName(path: string): string {
  const file = path.replace(/\\/g, '/').split('/').pop() ?? path
  if (/msedge/i.test(file)) return 'Microsoft Edge'
  if (/brave/i.test(file)) return 'Brave'
  if (/chromium/i.test(file)) return 'Chromium'
  if (/chrome/i.test(file)) return 'Google Chrome'
  return file
}

// The one the person picked, remembered in settings. Until they pick, a single
// installed browser is not a choice and is simply used; several of them are a
// choice, and a choice is theirs.
let chosenPath: string | null = null

export function setAgentBrowser(path: string | null): void {
  chosenPath = path && existsSync(path) ? path : null
}

// The browser the system opens links with, by the name Windows records for
// it. Elsewhere, and where the record cannot be read, the first one found.
// Read once: it is a process, and availability is asked on every focus.
let usualBrowser: string | null | undefined
function defaultBrowserName(): string | null {
  if (usualBrowser !== undefined) return usualBrowser
  usualBrowser = readDefaultBrowserName()
  return usualBrowser
}

function readDefaultBrowserName(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId'],
      { encoding: 'utf8', windowsHide: true, timeout: 3_000 },
    )
    const progId = /ProgId\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? ''
    if (/chrome/i.test(progId)) return 'Google Chrome'
    if (/edge/i.test(progId)) return 'Microsoft Edge'
    if (/brave/i.test(progId)) return 'Brave'
  } catch {
    /* no record to read */
  }
  return null
}

// The browser the comet works in: the one the person picked, else the one
// their system opens links with, else the first installed. Nobody is asked.
export function findChrome(): string | null {
  if (chosenPath && existsSync(chosenPath)) return chosenPath
  const installed = installedBrowsers()
  const usual = defaultBrowserName()
  return installed.find((one) => one.name === usual)?.path ?? installed[0]?.path ?? null
}

// Whether a choice is still open: only when nothing at all is installed.
export function browserChoicePending(): boolean {
  return installedBrowsers().length === 0
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

// What a browser weighs by the time its window is up. Spoken for while it is
// on its way, so a model planned in that gap plans around it; once the window
// is open its real use is visible to every plan and the word is given back.
const LAUNCH_FOOTPRINT = 1e9

async function ensureContext(): Promise<Ctx> {
  if (context) return context
  if (opening) return opening
  const spokenFor = reserveRoom(LAUNCH_FOOTPRINT)
  opening = (async () => {
    const executablePath = findChrome()
    if (!executablePath) throw new Error('no Chrome-family browser found — install Google Chrome to run web errands')
    // A browser opening beside a resident model is the pairing that freezes
    // machines: the model was admitted against a measurement Chrome then
    // spends. Ask for the room before taking it.
    if (os.freemem() < ROOM_FOR_BROWSER && releaseModelForRoom(`opening the browser with ${(os.freemem() / 1e9).toFixed(1)}GB free`))
      // Freeing is a message to another process; give the pages a moment to
      // come back before measuring what is left.
      for (let waited = 0; waited < 4_000 && os.freemem() < ROOM_FOR_BROWSER; waited += 250)
        await new Promise((resolve) => setTimeout(resolve, 250))
    if (os.freemem() < LAUNCH_MIN_FREE)
      throw new Error(`not enough free memory to open the agent browser (${(os.freemem() / 1e9).toFixed(1)}GB free)`)
    const { chromium } = await import('playwright-core')
    // One more chance for the person's sign-ins to follow them in, right
    // before the window they would need them in. Costs nothing when their
    // browser is open or the last copy is fresh.
    await autoImportSession(executablePath).catch(() => undefined)
    const profileDir = join(app.getPath('userData'), 'agent-browser-profile')
    flog('agent-browser', `launching ${executablePath}`)
    const ctx = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      // One frame for every page: a layout that does not depend on the
      // person's screen reads the same on every machine, and a taught
      // procedure replays against the page it was shown.
      viewport: { width: 1440, height: 900 },
      args: [
        '--window-size=1440,900',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        // The driver's own banner. Left on, a search engine answers its robot
        // check instead of the page — measured: the same query returns nothing
        // with the flag and a full page of results without it.
        '--disable-blink-features=AutomationControlled',
        // Test harness hook: exposes a CDP endpoint so an e2e run can stand in
        // for the person's hands in the agent window. Never set in production.
        ...(process.env['ENGRAM_AGENT_CDP'] ? [`--remote-debugging-port=${process.env['ENGRAM_AGENT_CDP']}`] : []),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    })
    // The flag has a twin in the DOM; both have to go or neither matters.
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
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
    spokenFor()
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
  const { text, hasPasswordField, links, controls } = await page
    .evaluate(() => {
      const root = document.querySelector('article, main') ?? document.body
      // Every anchor that leaves this host, with the words on it. No selector
      // here belongs to any particular site: a results page, a wiki index and
      // a portal menu are all just lists of links, which is how a page can be
      // followed without this app knowing a single search engine.
      const here = location.hostname
      const seen = new Set<string>()
      const found: { text: string; url: string }[] = []
      for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
        const href = (anchor as HTMLAnchorElement).href
        const label = ((anchor as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()
        if (!/^https?:/.test(href) || label.length < 4 || seen.has(href)) continue
        // Same-host links are kept: a company's own search links to its own
        // pages, and dropping them left an intranet search with no results.
        // Only the page itself is uninteresting.
        try {
          if (new URL(href).href.split('#')[0] === location.href.split('#')[0]) continue
        } catch {
          continue
        }
        void here
        seen.add(href)
        found.push({ text: label.slice(0, 120), url: href })
        if (found.length >= 25) break
      }
      // What a page can be asked to do, as short lines: its buttons, fields
      // and menus with the words on them. Far smaller than the markup, and
      // what a small model needs to pick the next move without reading the
      // whole page again.
      const controls: string[] = []
      const seenControl = new Set<string>()
      for (const el of Array.from(document.querySelectorAll('button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], a[href][role]'))) {
        const node = el as HTMLElement
        if (node.hidden || node.getAttribute('aria-hidden') === 'true') continue
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        const tag = node.tagName.toLowerCase()
        const role = node.getAttribute('role') ?? (tag === 'input' ? `input:${(node as HTMLInputElement).type || 'text'}` : tag)
        if (role === 'input:hidden') continue
        const name = (node.getAttribute('aria-label') ?? node.getAttribute('placeholder') ?? node.getAttribute('name') ?? node.innerText ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
        if (!name) continue
        const line = `[${role}] ${name}`
        if (seenControl.has(line)) continue
        seenControl.add(line)
        controls.push(line)
        if (controls.length >= 40) break
      }
      return {
        text: ((root as HTMLElement | null)?.innerText ?? '').replace(/\n{3,}/g, '\n\n'),
        hasPasswordField: document.querySelector('input[type="password"]') !== null,
        links: found,
        controls,
      }
    })
    .catch(() => ({ text: '', hasPasswordField: false, links: [] as { text: string; url: string }[], controls: [] as string[] }))
  const wall = classifyWall(url, title, text, hasPasswordField)
  return { url, title, text: text.slice(0, PAGE_TEXT_CAP), links, controls, ...(wall ? { wall } : {}) }
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

// One browser, one reused tab. It knows how to open, read, type and click —
// and nothing at all about search engines: where to go is the caller's
// judgement, which is what lets it be sent somewhere new.
export function agentCourier(): WebCourier {
  return {
    async readOpen(signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      return withAbort(readPage(page), signal)
    },
    async typeInto(field, text, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      const done = await routineDriver().type({ text: field }, text, signal)
      void page
      return { ok: done.ok }
    },
    async clickOn(target, signal) {
      const page = await withAbort(ensurePage(), signal)
      armIdleClose()
      const done = await routineDriver().click({ text: target }, signal)
      void page
      return { ok: done.ok }
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
  return (chosenPath !== null && existsSync(chosenPath)) || installedBrowsers().length > 0
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
// The browser's half of taking turns: when the model would otherwise load
// CPU-bound beside it, an idle window - nobody at it, no recording holding it -
// closes and gives its room back. The next page opens a fresh one.
setRoomMaker(async () => {
  if (!context || claimed || idleHolds > 0) return false
  flog('agent-browser', 'stepping aside so the model has room')
  await closeAgentBrowser()
  return context === null
})

export async function closeAgentBrowser(options: { force?: boolean } = {}): Promise<void> {
  // Somebody is standing at the window - a recording, or a person typing their
  // password into a login wall. An unforced close waits for them; memory
  // pressure and app quit pass force and take it anyway.
  if ((claimed || idleHolds > 0) && !options.force) return
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
