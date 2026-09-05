import type { WebPage } from 'core'
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { autoImportSession } from './browser-import.js'
import { flog } from './flog.js'
import { markAgentProfile } from './agent-profile.js'
import { reserveRoom } from './memory-plan.js'
import { readFrames } from './page-reader.js'

// The errand's hands: the user's own Chrome, driven over CDP by
// playwright-core. Its window is an ordinary window — park it on another
// desktop and it works there alone; it never touches the user's mouse,
// keyboard or focus. A dedicated profile under userData keeps any login the
// user performs in that window across errands, which is the whole answer to
// SSO: the human logs in once, the agent browses logged-in after.

// Long enough for a slow portal, short enough that a page that will not
// come does not take the turn with it (measured: two waits at 25s were the
// whole of a three-minute answer).
export const NAV_TIMEOUT_MS = 15_000
const PAGE_TEXT_CAP = 12_000
// The browser is heavyweight company for an 8GB machine, so it leaves when
// nobody is using it. Long enough, though, that a person reading an answer
// and typing a follow-up still finds the page they were just shown: a window
// that closed under them is the difference between carrying on and starting
// the job again. Memory pressure still takes it away at any time.
const IDLE_CLOSE_MS = 15 * 60_000
// Below this the browser is the memory somebody else needs — it leaves.
const PRESSURE_CLOSE_FLOOR = 2e9
const LAUNCH_MIN_FREE = 2.5e9

// A page is watched as well as read: an icon, a logo, a photograph is how a
// person recognises where the work is, and a layout built around pictures
// that never arrive reads as a broken site. Only video and audio are turned
// away - megabytes that no reading and no watching needs.
const BLOCKED_RESOURCES = new Set(['media'])

// The page's own width, fixed for every machine and every pane.
export const VIEW_WIDTH = 1280
// Each lane keeps the viewport requested by its own conversation pane.
const VIEW_HEIGHT_MIN = 620
const VIEW_HEIGHT_MAX = 2200
const viewHeight = 860

export async function setViewHeight(height: number, lane = activeLaneName()): Promise<boolean> {
  const wanted = Math.round(Math.max(VIEW_HEIGHT_MIN, Math.min(VIEW_HEIGHT_MAX, height)))
  const page = lanePage(lane)
  if (!page || page.viewportSize()?.height === wanted) return false
  await page.setViewportSize({ width: VIEW_WIDTH, height: wanted }).catch((err: unknown) => {
    flog('agent-browser', `could not lay a page out at ${wanted}: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
  })
  flog('agent-browser', `lane ${lane} laid out at ${VIEW_WIDTH}x${wanted}`)
  return true
}

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
//
// Only a page asking for a SECRET is a wall. Sign-on flows are full of pages
// whose address says /sso or /auth and whose whole content is one Continue
// button - stopping at those hands the person a browser and asks them to
// drive it, which is the opposite of the point. So the address alone is not
// enough: a wall wants a password box, or a page plainly asking for a
// credential to be typed.
export function classifyWall(
  url: string,
  title: string,
  textHead: string,
  hasPasswordField: boolean,
): 'login' | 'captcha' | null {
  const head = `${title}\n${textHead.slice(0, 2_500)}`
  if (/captcha|are you a robot|not a robot|unusual traffic|verify you are human|one last step|real person|cloudflare.{0,40}checking|비정상적인 트래픽|로봇이 아니|사람인지 확인/i.test(head))
    return 'captcha'
  if (hasPasswordField) return 'login'
  const onAuthPath = /\/(login|signin|sign-in|sign_in|sso|auth)\b/i.test(new URL(url).pathname)
  const asksForCredentials =
    /\b(password|passcode|one[- ]time code|verification code|two[- ]factor|username|user id)\b|비밀번호|암호|인증번호|아이디/i.test(head)
  return onAuthPath && asksForCredentials ? 'login' : null
}

let context: Ctx | null = null
let opening: Promise<Ctx> | null = null
// A close under way: a launch waits for it, or it would trip on the profile
// the closing process still holds.
let closing: Promise<void> | null = null

// A window that closed a moment ago can hold its profile while the process
// winds down; a launch that trips on that is tried again shortly rather
// than reported as a page that would not open.
const LAUNCH_TRIES = 4
const LAUNCH_RETRY_MS = 2_500
async function launchPatiently<T>(launch: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch()
    } catch (err) {
      const said = String(err instanceof Error ? err.message : err)
      if (attempt >= LAUNCH_TRIES || !/profile|lock|in use|singleton|EBUSY|already running/i.test(said)) throw err
      flog('agent-browser', `profile still held, trying again (${attempt})`)
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_RETRY_MS))
    }
  }
}
// One tab per lane. A lane is whoever is working - a comet's channel, or
// the default for the errand and routine runs - and each keeps its own tab,
// so two comets at once never take each other's page, and a new comet never
// starts on a page an old one left open. The tabs share one browser and
// one profile: a sign-in made in any of them holds in all of them.
export const DEFAULT_LANE = 'default'
const lanes = new Map<string, Page>()
let allocatingLane: string | null = null
// The lane the person is looking at: the one the mirror follows, and the
// one a tab opened by a link is handed to when its opener is not known.
let activeLane = DEFAULT_LANE
// Another tab is only worth opening when the machine can afford it.
const LANE_MIN_FREE = 0.8e9

export function laneOf(page: Page): string | null {
  for (const [lane, held] of lanes) if (held === page) return lane
  return null
}

export function lanePage(lane: string): Page | null {
  const page = lanes.get(lane)
  return page && !page.isClosed() ? page : null
}

export function setActiveLane(lane: string): void {
  activeLane = lane
}

export function activeLaneName(): string {
  return activeLane
}

// The tab a lane holds is closed and forgotten: the next ask from that lane
// starts on a blank page. What a person presses when the page has got into
// a state neither they nor the comet can get out of.
export async function resetLane(lane: string): Promise<void> {
  const page = lanes.get(lane)
  lanes.delete(lane)
  if (page && !page.isClosed()) await page.close().catch(() => undefined)
}

// Whoever mirrors the window is told of every page as it opens, and which
// lane it belongs to.
const pageWatchers = new Set<(page: Page, lane: string | null) => void>()

export function watchAgentPages(watcher: (page: Page, lane: string | null) => void): () => void {
  pageWatchers.add(watcher)
  for (const page of context?.pages() ?? []) watcher(page, laneOf(page))
  return () => {
    pageWatchers.delete(watcher)
  }
}
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

export function armIdleClose(): void {
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
    if (closing) await closing.catch(() => undefined)
    const executablePath = findChrome()
    if (!executablePath) throw new Error('no Chrome-family browser found — install Google Chrome to run web errands')
    if (os.freemem() < LAUNCH_MIN_FREE)
      throw new Error(`not enough free memory to open the agent browser (${(os.freemem() / 1e9).toFixed(1)}GB free)`)
    const { chromium } = await import('playwright-core')
    // One more chance for the person's sign-ins to follow them in, right
    // before the window they would need them in. Costs nothing when their
    // browser is open or the last copy is fresh.
    await autoImportSession(executablePath).catch(() => undefined)
    const profileDir = join(app.getPath('userData'), 'agent-browser-profile')
    await markAgentProfile(profileDir).catch(() => undefined)
    flog('agent-browser', `launching ${executablePath}`)
    const ctx = await launchPatiently(() =>
      chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: false,
      // The driver's default drops the sandbox, and the browser says so in a
      // banner on every page; a person's window keeps its sandbox.
      chromiumSandbox: true,
      // The WIDTH never changes: a layout that does not depend on the
      // person's screen reads the same on every machine, a taught procedure
      // replays against the page it was shown, and no site drops to its
      // phone layout because a pane got narrow. A laptop's width, which is
      // what sites are built for. The HEIGHT follows the pane the person is
      // watching it in - see setViewHeight - so the picture fills what they
      // gave it instead of sitting in the top half of an empty box.
      viewport: { width: VIEW_WIDTH, height: viewHeight },
      // The page is laid out at 1280 CSS pixels and drawn at twice that, so
      // a still taken of it (what the person looks at when they open the
      // view) carries real detail instead of an enlarged blur. The live run
      // of frames is unaffected: a screencast is captured per CSS pixel
      // whatever this says - measured.
      deviceScaleFactor: 2,
      args: [
        `--window-size=${VIEW_WIDTH},${viewHeight}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        // The driver's own banner. Left on, a search engine answers its robot
        // check instead of the page — measured: the same query returns nothing
        // with the flag and a full page of results without it.
        '--disable-blink-features=AutomationControlled',
        // The browser tells the person about that flag in a banner on every
        // page; a test-typed process is spared the banner and changes nothing
        // else they can see. Measured: the banner names that flag alone.
        '--test-type',
        // The window opens off the screen: the person watches and works in
        // its mirror inside the app, and can call the window over when the
        // mirror is not enough. Parked there it still paints.
        '--window-position=-4000,-4000',
        // Test harness hook: exposes a CDP endpoint so an e2e run can stand in
        // for the person's hands in the agent window. Never set in production.
        ...(process.env['ENGRAM_AGENT_CDP'] ? [`--remote-debugging-port=${process.env['ENGRAM_AGENT_CDP']}`] : []),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      }),
    )
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
        lanes.clear()
      }
      flog('agent-browser', 'closed')
    })
    ctx.on('page', (page) => {
      const requestedLane = allocatingLane
      // A link that opened a new tab is followed there, by the lane whose
      // page opened it: the newest page is the one that lane now means.
      void page
        .opener()
        .catch(() => null)
        .then((opener) => {
          // A page a lane already claimed for itself (ensureAgentPage sets
          // the map before this async lookup lands) keeps its owner: falling
          // back to the active lane here handed one comet's fresh tab to
          // whichever comet the person happened to be looking at.
          const claimed = laneOf(page)
          const lane = claimed ?? (opener && laneOf(opener)) ?? requestedLane ?? activeLane
          if (!claimed) lanes.set(lane, page)
          for (const watcher of pageWatchers) watcher(page, lane)
        })
    })
    context = ctx
    for (const page of ctx.pages()) for (const watcher of pageWatchers) watcher(page, laneOf(page))
    armPressureWatch()
    return ctx
  })().finally(() => {
    spokenFor()
    opening = null
  })
  return opening
}

let assigningPage: Promise<unknown> = Promise.resolve()

export function ensureAgentPage(lane = DEFAULT_LANE): Promise<Page> {
  const held = lanePage(lane)
  if (held) return Promise.resolve(held)
  const next = assigningPage.catch(() => undefined).then(() => assignAgentPage(lane))
  assigningPage = next
  return next
}

async function assignAgentPage(lane: string): Promise<Page> {
  const ctx = await ensureContext()
  const held = lanePage(lane)
  if (held) return held
  // The tab the browser opened with belongs to whoever asks first; after
  // that every lane gets a tab of its own, if the machine has room for one.
  const spare = ctx.pages().find((page) => !page.isClosed() && laneOf(page) === null)
  if (!spare && lanes.size > 0 && os.freemem() < LANE_MIN_FREE)
    throw new Error(`not enough free memory for another page while other work is open (${(os.freemem() / 1e9).toFixed(1)}GB free) - wait for it to finish`)
  let page = spare
  if (!page) {
    allocatingLane = lane
    try { page = await ctx.newPage() } finally { allocatingLane = null }
  }
  lanes.set(lane, page)
  for (const watcher of pageWatchers) watcher(page, lane)
  return page
}

// What the page shows, through every frame and open shadow root, with its
// controls numbered so a press can name one that has no words.
export async function readPage(page: Page): Promise<WebPage> {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const reading = await readFrames(page).catch(() => null)
  const text = reading?.text ?? ''
  const wall = classifyWall(url, title, text, reading?.hasPasswordField ?? false)
  return {
    url,
    title,
    text: text.slice(0, PAGE_TEXT_CAP),
    links: reading?.links ?? [],
    controls: reading?.lines ?? [],
    ...(reading?.hidden ? { hidden: reading.hidden } : {}),
    ...(reading?.dialog ? { dialog: reading.dialog } : {}),
    ...(reading?.faults?.length ? { faults: reading.faults } : {}),
    ...(wall ? { wall } : {}),
  }
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

// The recorder drives the same window: it needs the context itself, and the
// tabs open in it, which nothing else outside this module does.
export async function agentContext(): Promise<Ctx> {
  return ensureContext()
}

export function agentPages(): Page[] {
  return context?.pages().filter((one) => !one.isClosed()) ?? []
}

// The tab the person is looking at: the active lane's, or none.
export function currentAgentPage(): Page | null {
  return lanePage(activeLane)
}

export function agentBrowserAvailable(): boolean {
  return (chosenPath !== null && existsSync(chosenPath)) || installedBrowsers().length > 0
}

// Low-level access for the routine driver: same browser, same reused tab,
// same idle and pressure lifecycle the courier lives under.
export async function agentPage(signal?: AbortSignal, lane = DEFAULT_LANE): Promise<Page> {
  const page = await withAbort(ensureAgentPage(lane), signal)
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
    lanes.clear()
  }
  if (!held) return
  const done = held.close().catch(() => undefined)
  closing = done
  try {
    await done
  } finally {
    if (closing === done) closing = null
  }
}
