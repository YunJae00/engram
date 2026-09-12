import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions, type Rectangle, type WebContents } from 'electron'
import { join } from 'node:path'
import type { DesktopControlStatusDto } from '../shared/desktop.js'
import type { EngramEvent } from '../shared/types.js'
import { allowNavigation } from './security.js'

// While a comet holds the computer the person sees it everywhere: a glow along
// the edges of every display, a pill on the display under the pointer that
// says who is moving the mouse, and a companion riding beside the pointer.
// Every window here is content-protected (absent from the comet's own
// screenshots), non-focusable (never takes the foreground from the app being
// controlled) and dies with the app. Input must not start without a visible
// stop window; an unavailable overlay fails preparation closed.

const PILL_WIDTH = 440
// The pill is 44 tall; the rest is room for its floating shadow.
const PILL_HEIGHT = 60
const PILL_TOP_INSET = 56
const POINTER_POLL_MS = 33
// Windows' topmost band is last-set-wins: whichever window asked most recently
// sits above, so the claim is renewed while shown.
const TOPMOST_REASSERT_MS = 5000
// A resolution or DPI change fires once per display; one rebuild covers them.
const REBUILD_DEBOUNCE_MS = 200
// The renderer paints a boot word before React runs; on a see-through window
// it would float over the person's screen for a frame.
const BOOT_WORD_CSS = '#boot{display:none!important}'

interface GlowWindow { win: BrowserWindow; bounds: Rectangle }
interface Point { x: number; y: number }

let glows: GlowWindow[] = []
let pill: BrowserWindow | null = null
let status: DesktopControlStatusDto = { state: 'idle' }
let shown = false
let hooked = false
let lastPoint: Point | null = null
const ready = new Set<BrowserWindow>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let topTimer: ReturnType<typeof setInterval> | null = null
let rebuildTimer: ReturnType<typeof setTimeout> | null = null

function contains(bounds: Rectangle, point: Point): boolean {
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height
}

function statusEvent(): EngramEvent {
  return { type: 'desktop:control', control: status }
}

function send(win: BrowserWindow | null, event: EngramEvent): void {
  if (!win || win.isDestroyed()) return
  if (event.type === 'desktop:control' && event.control.application) {
    const glow = glows.find((one) => one.win === win)
    const application = event.control.application
    if (glow) event = { ...event, control: { ...event.control, application: { ...application, bounds: { ...application.bounds, x: application.bounds.x - glow.bounds.x, y: application.bounds.y - glow.bounds.y } } } }
  }
  win.webContents.send('engram:event', event)
}

function broadcast(event: EngramEvent): void {
  for (const glow of glows) send(glow.win, event)
  send(pill, event)
}

function liveWindows(): BrowserWindow[] {
  const all = [...glows.map((glow) => glow.win), ...(pill ? [pill] : [])]
  return all.filter((win) => !win.isDestroyed())
}

// The same lockdown every app window gets: the bundle may reload itself but
// never navigate elsewhere or open a child window.
function harden(contents: WebContents): void {
  const deny = (event: { preventDefault: () => void }, url: string): void => {
    if (!allowNavigation(url, process.env['ELECTRON_RENDERER_URL'])) event.preventDefault()
  }
  contents.on('will-navigate', (event, url) => deny(event, url))
  contents.on('will-redirect', (event, url) => deny(event, url))
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function load(win: BrowserWindow, hash: string): void {
  const dev = process.env['ELECTRON_RENDERER_URL']
  const loading = dev ? win.loadURL(`${dev}#${hash}`) : win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash })
  void Promise.resolve(loading).catch((error: unknown) => console.error('control overlay failed to load', error))
}

function windowOptions(bounds: Rectangle): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: false,
    type: 'toolbar',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  }
}

// Windows trims a plain window to the work area when it is made; only once
// it sits above the taskbar may it take the whole display, so the size is
// asked for again after the level is set.
function fit(win: BrowserWindow): void {
  const glow = glows.find((one) => one.win === win)
  if (glow) win.setBounds({ ...glow.bounds, height: Math.max(1, glow.bounds.height - 1) })
}

function reveal(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  // showInactive, not show: even a focusable window would stay behind the
  // controlled app's foreground claim this way.
  win.showInactive()
  win.setAlwaysOnTop(true, 'screen-saver')
  fit(win)
  // The pill must sit above the glow that covers its display.
  if (pill && win !== pill && !pill.isDestroyed() && pill.isVisible()) pill.setAlwaysOnTop(true, 'screen-saver')
}

function createWindow(bounds: Rectangle, hash: string): BrowserWindow {
  const win = new BrowserWindow(windowOptions(bounds))
  harden(win.webContents)
  win.setContentProtection(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setBounds(bounds)
  try {
    if (typeof win.setVisibleOnAllWorkspaces === 'function') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } catch (error) {
    console.error('control overlay workspace visibility', error)
  }
  win.webContents.on('dom-ready', () => {
    void Promise.resolve(win.webContents.insertCSS(BOOT_WORD_CSS)).catch((error: unknown) => console.error('control overlay boot word', error))
  })
  // A window still loading when the status was broadcast would miss it.
  win.webContents.on('did-finish-load', () => send(win, statusEvent()))
  win.once('ready-to-show', () => {
    ready.add(win)
    if (shown) reveal(win)
  })
  load(win, hash)
  return win
}

function pillBounds(): Rectangle {
  const displays = screen.getAllDisplays()
  const cursor = screen.getCursorScreenPoint()
  const home = displays.find((display) => contains(display.bounds, cursor))?.bounds ?? displays[0]?.bounds ?? { x: 0, y: 0, width: PILL_WIDTH, height: PILL_HEIGHT }
  if (status.application) {
    const bounds = status.application.bounds
    const work = screen.getDisplayMatching(bounds).workArea
    return { x: Math.max(work.x, Math.min(work.x + work.width - PILL_WIDTH, bounds.x + Math.round((bounds.width - PILL_WIDTH) / 2))), y: Math.max(work.y + 4, bounds.y - PILL_HEIGHT + 8), width: PILL_WIDTH, height: PILL_HEIGHT }
  }
  return { x: home.x + Math.round((home.width - PILL_WIDTH) / 2), y: home.y + PILL_TOP_INSET, width: PILL_WIDTH, height: PILL_HEIGHT }
}

function placePill(): void {
  if (!pill || pill.isDestroyed()) return
  pill.setBounds(pillBounds())
}

function build(): void {
  if (glows.length > 0 || pill) return
  for (const display of screen.getAllDisplays()) {
    const bounds = display.bounds
    // A see-through window the exact size of its display is taken for a
    // fullscreen one and loses its transparency; one row short keeps it.
    const win = createWindow({ ...bounds, height: Math.max(1, bounds.height - 1) }, 'overlay')
    win.setIgnoreMouseEvents(true)
    glows.push({ win, bounds })
  }
  pill = createWindow(pillBounds(), 'overlay-pill')
}

function showAll(): void {
  for (const win of liveWindows()) if (ready.has(win)) reveal(win)
}

function stopTimers(): void {
  if (pollTimer) clearInterval(pollTimer)
  if (topTimer) clearInterval(topTimer)
  pollTimer = null
  topTimer = null
}

function sendPointer(point: Point, press?: boolean): void {
  if (status.application) return
  const previous = lastPoint && glows.find((glow) => contains(glow.bounds, lastPoint!))
  lastPoint = point
  const target = glows.find((glow) => contains(glow.bounds, point))
  if (!target) return
  if (previous && previous !== target) send(previous.win, { type: 'desktop:control', control: { state: 'idle' } })
  if (previous && previous !== target) send(previous.win, statusEvent())
  const local = { x: point.x - target.bounds.x, y: point.y - target.bounds.y }
  send(target.win, press === undefined ? { type: 'desktop:pointer', ...local } : { type: 'desktop:pointer', ...local, press })
}

// The companion also follows a pointer the hands moved natively, which never
// passes through overlayPointer.
function pollPointer(): void {
  try {
    const point = screen.getCursorScreenPoint()
    if (lastPoint && lastPoint.x === point.x && lastPoint.y === point.y) return
    sendPointer(point)
  } catch (error) {
    console.error('control overlay pointer poll', error)
  }
}

function reassertTopmost(): void {
  try {
    for (const win of liveWindows()) if (win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver')
  } catch (error) {
    console.error('control overlay topmost', error)
  }
}

function startTimers(): void {
  if (!pollTimer) pollTimer = setInterval(pollPointer, POINTER_POLL_MS)
  if (!topTimer) topTimer = setInterval(reassertTopmost, TOPMOST_REASSERT_MS)
}

function destroyAll(): void {
  stopTimers()
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = null
  for (const win of liveWindows()) win.destroy()
  glows = []
  pill = null
  ready.clear()
  lastPoint = null
}

// Display geometry changed under the windows: rebuild them to the new bounds
// (a resized transparent window does not repaint reliably) and, if the comet
// still has the computer, put them straight back.
function rebuild(): void {
  rebuildTimer = null
  try {
    destroyAll()
    if (shown) showControlOverlay(status)
  } catch (error) {
    console.error('control overlay rebuild', error)
  }
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(rebuild, REBUILD_DEBOUNCE_MS)
}

function hook(): void {
  if (hooked) return
  hooked = true
  screen.on('display-added', scheduleRebuild)
  screen.on('display-removed', scheduleRebuild)
  screen.on('display-metrics-changed', scheduleRebuild)
  app.on('before-quit', destroyAll)
}

export function showControlOverlay(next: DesktopControlStatusDto): void {
  try {
    hook()
    status = next
    shown = true
    build()
    placePill()
    broadcast(statusEvent())
    showAll()
    startTimers()
  } catch (error) {
    console.error('control overlay could not be shown', error)
  }
}

// Native input starts only after the single stop window is visible.
export async function prepareControlOverlay(next: DesktopControlStatusDto): Promise<string> {
  showControlOverlay({ ...next, state: 'running' })
  const expected = pill
  // A cold renderer can take over five seconds under endpoint protection.
  // No input is held while waiting, and the loaded windows are reused.
  const deadline = Date.now() + 30000
  while (shown && pill === expected && expected && !expected.isDestroyed()) {
    if (ready.has(expected) && expected.isVisible()) return expected.getNativeWindowHandle().readBigUInt64LE().toString()
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The computer control stop overlay is unavailable.')
}

export function updateControlOverlay(next: DesktopControlStatusDto): void {
  try {
    status = next
    if (shown) placePill()
    broadcast(statusEvent())
  } catch (error) {
    console.error('control overlay could not be updated', error)
  }
}

// Hidden, not destroyed: nothing composites while idle, and the next control
// session shows the same windows without a fresh load.
export function hideControlOverlay(): void {
  try {
    shown = false
    status = { state: 'idle' }
    lastPoint = null
    stopTimers()
    broadcast(statusEvent())
    for (const win of liveWindows()) win.hide()
  } catch (error) {
    console.error('control overlay could not be hidden', error)
  }
}

// What the overlay is showing right now: a window that mounts after the
// broadcast asks for this instead of guessing from the control lease.
export function overlayStatus(): DesktopControlStatusDto {
  return shown ? status : { state: 'idle' }
}

// webContents ids, so IPC handlers can tell the overlay's requests from a
// stranger's.
export function overlayWindowIds(): number[] {
  try {
    return liveWindows().map((win) => win.webContents.id)
  } catch (error) {
    console.error('control overlay ids', error)
    return []
  }
}

// The comet moved or pressed the pointer: only the display under the point
// hears about it, in that window's own coordinates.
export function overlayPointer(point: Point, press?: boolean): void {
  try {
    if (!shown) return
    sendPointer(point, press)
  } catch (error) {
    console.error('control overlay pointer', error)
  }
}
