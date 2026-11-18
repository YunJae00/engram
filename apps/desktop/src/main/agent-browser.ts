import { availableMemory } from './available-memory.js'
import { classifyWall } from './page-wall.js'
import type { WebPage } from 'core'
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { autoImportSession } from './browser-import.js'
import { flog } from './flog.js'
import { watchStalledScripts } from './stalled-scripts.js'
import { markAgentProfile } from './agent-profile.js'
import { reserveRoom } from './memory-plan.js'
import { observationOf, readFrames } from './page-reader.js'
import { createWindowPage } from './browser-window-page.js'
import { BrowserLanes } from './browser-lanes.js'
import { closeNativeBrowser, createNativePage, isNativeContext, isNativePage, nativeBrowserEnabled, nativeBrowserPid, nativeOpener, openNativeBrowser } from './native-browser.js'
import { nativePagesVisible } from './native-layout.js'
import { resizePreview } from './page-preview.js'
import { takeDownloads, watchDownloads } from './page-downloads.js'

export const NAV_TIMEOUT_MS = 15_000
const PAGE_TEXT_CAP = 64_000
const IDLE_CLOSE_MS = 15 * 60_000
const PRESSURE_CLOSE_FLOOR = 0.8e9
const LAUNCH_MIN_FREE = 1.2e9

const BLOCKED_RESOURCES = new Set(['media'])

const VIEW_WIDTH = 1280
const VIEW_HEIGHT_MIN = 240
const VIEW_HEIGHT_MAX = 2200
const viewHeight = 860

export async function setViewHeight(height: number, lane = activeLaneName(), width = VIEW_WIDTH): Promise<boolean> {
  const wanted = Math.round(Math.max(VIEW_HEIGHT_MIN, Math.min(VIEW_HEIGHT_MAX, height)))
  const wantedWidth = Math.round(Math.max(360, Math.min(1920, width)))
  const page = lanePage(lane)
  if (!page || isNativePage(page)) return false
  const changed = await resizePreview(page, { width: wantedWidth, height: wanted }).catch((err: unknown) => {
    flog('agent-browser', `could not lay a page out at ${wanted}: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
    return false
  })
  if (changed) flog('agent-browser', `lane ${lane} laid out at ${wantedWidth}x${wanted}`)
  return changed
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

interface InstalledBrowser {
  id: string
  name: string
  path: string
}

export function installedBrowsers(): InstalledBrowser[] {
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

let chosenPath: string | null = null

export function setAgentBrowser(path: string | null): void {
  chosenPath = path && existsSync(path) ? path : null
}

let usualBrowser: Promise<string | null> | undefined
const execFileAsync = promisify(execFile)

async function readDefaultBrowserName(): Promise<string | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); ObjC.unwrap($.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com")).lastPathComponent)'], { encoding: 'utf8', timeout: 3000 })
      return ['Google Chrome', 'Microsoft Edge', 'Brave'].find(name => stdout.trim() === `${name}.app` || (name === 'Brave' && stdout.trim() === 'Brave Browser.app')) ?? null
    } catch { return null }
  }
  if (process.platform !== 'win32') return null
  try {
    const { stdout: out } = await execFileAsync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice', '/v', 'ProgId'],
      { encoding: 'utf8', windowsHide: true, timeout: 3_000 },
    )
    const progId = /ProgId\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? ''
    if (/chrome/i.test(progId)) return 'Google Chrome'
    if (/edge/i.test(progId)) return 'Microsoft Edge'
    if (/brave/i.test(progId)) return 'Brave'
  } catch {
  }
  return null
}

export async function findChrome(): Promise<string | null> {
  if (chosenPath && existsSync(chosenPath)) return chosenPath
  const installed = installedBrowsers()
  const usual = await (usualBrowser ??= readDefaultBrowserName())
  return installed.find((one) => one.name === usual)?.path ?? installed[0]?.path ?? null
}

export function browserChoicePending(): boolean {
  if (nativeBrowserEnabled()) return false
  return installedBrowsers().length === 0
}

export { classifyWall }

let context: Ctx | null = null
export async function agentBrowserPids(): Promise<number[]> {
  const nativePid = context && isNativeContext(context) ? nativeBrowserPid() : undefined
  const pids = nativePid ? [nativePid] : []
  const browser = context?.browser()
  if (!browser) return pids
  const session = await browser.newBrowserCDPSession().catch(() => null)
  if (!session) return pids
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
    return [...pids, ...processInfo.map(info => info.id)]
  } catch { return pids }
  finally { await session.detach().catch(() => undefined) }
}
let opening: Promise<Ctx> | null = null
let closing: Promise<void> | null = null

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
export const DEFAULT_LANE = 'default'
const lanes = new BrowserLanes((page, lane) => {
  for (const watcher of pageWatchers) watcher(page, lane)
})
let allocatingPages = 0
let activeLane = DEFAULT_LANE
const LANE_MIN_FREE = LAUNCH_MIN_FREE

export function laneOf(page: Page): string | null {
  return lanes.owner(page)
}

export function lanePage(lane: string): Page | null {
  const page = lanes.get(lane)
  return page && !page.isClosed() ? page : null
}

export function laneLastUrl(lane: string): string | undefined { return lanes.lastUrl(lane) }

export function lanePages(lane: string): Page[] { return lanes.pages(lane).filter(page => !page.isClosed()) }

export function selectLanePage(lane: string, page: Page): void {
  if (laneOf(page) !== lane || page.isClosed()) throw new Error('That tab is not in this conversation')
  lanes.set(lane, page)
  for (const watcher of pageWatchers) watcher(page, lane)
}

export function setActiveLane(lane: string): void {
  activeLane = lane
}

export function activeLaneName(): string {
  return activeLane
}

export async function resetLane(lane: string): Promise<void> {
  const pages = lanes.pages(lane)
  lanes.delete(lane)
  await Promise.all(pages.filter((page) => !page.isClosed()).map((page) => page.close().catch(() => undefined)))
}

const pageWatchers = new Set<(page: Page, lane: string | null) => void>([watchDownloads(laneOf)])

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
    const free = availableMemory()
    if (free < PRESSURE_CLOSE_FLOOR) {
      flog('agent-browser', `memory pressure (${(free / 1e9).toFixed(1)}GB free) — closing`)
      void closeAgentBrowser({ force: true })
    }
  }, 15_000).unref()
}

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

const LAUNCH_FOOTPRINT = 1e9

async function ensureContext(): Promise<Ctx> {
  if (context) return context
  if (opening) return opening
  const spokenFor = reserveRoom(LAUNCH_FOOTPRINT)
  opening = (async () => {
    if (closing) await closing.catch(() => undefined)
    if (availableMemory() < LAUNCH_MIN_FREE)
      throw new Error(`not enough free memory to open the agent browser (${(availableMemory() / 1e9).toFixed(1)}GB free)`)
    if (nativeBrowserEnabled()) {
      const ctx = await openNativeBrowser()
      context = ctx
      watchStalledScripts(ctx)
      ctx.on('close', () => { if (context === ctx) { context = null; lanes.clear() } })
      ctx.on('page', (page) => {
        const requestedLane = allocatingPages === 0 ? activeLane : null
        void nativeOpener(page).catch(() => null).then((opener) => {
          const lane = laneOf(page) ?? (opener && laneOf(opener)) ?? requestedLane
          if (lane && !laneOf(page)) lanes.set(lane, page)
          for (const watcher of pageWatchers) watcher(page, lane)
        })
      })
      armPressureWatch()
      return ctx
    }
    const executablePath = await findChrome()
    if (!executablePath) throw new Error('no Chrome-family browser found — install Google Chrome to run web errands')
    const { chromium } = await import('playwright-core')
    await autoImportSession(executablePath).catch(() => undefined)
    const profileDir = join(app.getPath('userData'), 'agent-browser-profile')
    await markAgentProfile(profileDir).catch(() => undefined)
    flog('agent-browser', `launching ${executablePath}`)
    const ctx = await launchPatiently(() =>
      chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: process.platform === 'darwin',
      chromiumSandbox: true,
      viewport: { width: VIEW_WIDTH, height: viewHeight },
      deviceScaleFactor: 2,
      args: [
        `--window-size=${VIEW_WIDTH},${viewHeight}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-blink-features=AutomationControlled',
        '--test-type',
        '--window-position=-4000,-4000',
        ...(process.env['ENGRAM_AGENT_CDP'] ? [`--remote-debugging-port=${process.env['ENGRAM_AGENT_CDP']}`] : []),
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      }),
    )
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
    })
    await ctx.route('**/*', (route) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort()
      return route.continue()
    })
    watchStalledScripts(ctx)
    ctx.on('close', () => {
      if (context === ctx) {
        context = null
        lanes.clear()
      }
      flog('agent-browser', 'closed')
    })
    ctx.on('page', (page) => {
      const requestedLane = allocatingPages === 0 ? activeLane : null
      void page
        .opener()
        .catch(() => null)
        .then((opener) => {
          const claimed = laneOf(page)
          const lane = claimed ?? (opener && laneOf(opener)) ?? requestedLane
          if (lane && !claimed) lanes.set(lane, page)
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

const assigningPages = new Map<string, Promise<unknown>>()

export function ensureAgentPage(lane = DEFAULT_LANE): Promise<Page> {
  const held = lanePage(lane)
  return held ? Promise.resolve(held) : assignAgentPage(lane)
}

export function addAgentPage(lane: string): Promise<Page> {
  return assignAgentPage(lane, true)
}

async function assignAgentPage(lane: string, fresh = false): Promise<Page> {
  const before = assigningPages.get(lane) ?? Promise.resolve()
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined
  const waiting = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new Error('This conversation is still opening a browser page. The queued page did not start within 30 seconds.')) }, 30_000)
  })
  const next = before.catch(() => undefined).then(async () => {
    clearTimeout(timer)
    if (expired) throw new Error('The queued browser page expired without opening.')
    if (fresh && lanePages(lane).length >= 8) throw new Error('Close a tab before opening another')
    const ctx = await ensureContext()
    const held = lanePage(lane)
    if (held && !fresh) return held
    const spare = lanes.size === 0 ? ctx.pages().find((page) => !page.isClosed() && laneOf(page) === null) : undefined
    if (!spare && lanes.size > 0 && availableMemory() < LANE_MIN_FREE)
      throw new Error(`not enough free memory for another browser tab right now (${(availableMemory() / 1e9).toFixed(1)}GB free). Do not wait, sleep or poll for memory: open_page, read_pages and search_web read pages without a tab, so use those, another source, or report what you have.`)
    let page = spare
    if (!page) {
      allocatingPages++
      try { page = isNativeContext(ctx) ? await createNativePage(ctx) : await createWindowPage(ctx, { width: VIEW_WIDTH, height: viewHeight }) } finally { allocatingPages-- }
    }
    lanes.set(lane, page)
    for (const watcher of pageWatchers) watcher(page, lane)
    return page
  })
  const tail = next.catch(() => undefined).finally(() => { if (assigningPages.get(lane) === tail) assigningPages.delete(lane) })
  assigningPages.set(lane, tail)
  try { return await Promise.race([next, waiting]) } finally { clearTimeout(timer) }
}

export async function readPage(page: Page, signal?: AbortSignal): Promise<WebPage> {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const reading = await readFrames(page, signal).catch(() => null)
  signal?.throwIfAborted()
  const text = reading?.text ?? ''
  const wall = classifyWall(url, title, `${reading?.dialog ?? ''}\n${text}`, reading?.hasPasswordField ?? false)
  return {
    url,
    title,
    observation: { ...observationOf(page) },
    text: text.slice(0, PAGE_TEXT_CAP) + (text.length > PAGE_TEXT_CAP ? '\n[Page extract truncated; absence from this extract does not establish absence from the page.]' : ''),
    links: reading?.links ?? [],
    controls: reading?.lines ?? [],
    ...(reading?.hidden ? { hidden: reading.hidden } : {}),
    ...(reading?.dialog ? { dialog: reading.dialog } : {}),
    ...(reading?.faults?.length ? { faults: reading.faults } : {}),
    ...downloadsOf(page),
    ...(wall ? { wall } : {}),
  }
}

function downloadsOf(page: Page): { downloads?: string[] } {
  const lane = laneOf(page)
  const saved = lane ? takeDownloads(lane) : []
  return saved.length ? { downloads: saved } : {}
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

export async function agentContext(): Promise<Ctx> {
  return ensureContext()
}

export function agentBrowserRunning(): boolean { return context !== null || opening !== null || closing !== null }

export function agentBrowserAvailable(): boolean {
  if (nativeBrowserEnabled()) return true
  return (chosenPath !== null && existsSync(chosenPath)) || installedBrowsers().length > 0
}

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

export async function closeAgentBrowser(options: { force?: boolean } = {}): Promise<void> {
  if (closing) return closing
  if (nativePagesVisible() && !options.force) return
  if (idleHolds > 0 && !options.force) return
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (pressureTimer) {
    clearInterval(pressureTimer)
    pressureTimer = null
  }
  const held = context ?? (await opening?.catch(() => null)) ?? null
  if (held === context) {
    context = null
    lanes.clear()
  }
  if (!held) { await closeNativeBrowser(); return }
  const done = isNativeContext(held) ? closeNativeBrowser() : held.close().catch(() => undefined)
  closing = done
  try {
    await done
  } finally {
    if (closing === done) closing = null
  }
}
