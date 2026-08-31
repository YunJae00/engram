import type { CDPSession, Page } from 'playwright-core'
import type { AgentInputDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import { agentPages, ensureAgentPage, watchAgentPages } from './agent-browser.js'
import { flog } from './flog.js'

// The agent's window stays out of sight. What it shows is mirrored into the
// app as a run of small frames, and what the person does on the mirror —
// a sign-in, a robot check, a lesson — is played back into the window as
// their own clicks and keys. Frames go to the screen and nowhere else: none
// is written, logged or kept past the next one.

// Frames come at the screen's own pixel density (the page is 1280 wide in
// CSS pixels; on a dense screen that is more device pixels), so the mirror
// stays sharp however large the window shows it.
// A screencast frame comes at the page's own CSS size however high the cap
// is set (measured), so the cap only guards against a very large viewport.
// Quality is what is left to spend, and a page of text wants it.
const FRAME = { format: 'jpeg', quality: 72, maxWidth: 1920, maxHeight: 1200 } as const
const ON_SCREEN = { left: 120, top: 80 }
const OFF_SCREEN = { left: -4000, top: -4000 }

interface Mirror {
  page: Page
  cdp: CDPSession
  // When a frame last went out, and whether a photograph is being taken.
  painted: number
  shooting: boolean
  // The page's own size, which the frame is a scaled copy of; pointer
  // positions arrive as fractions and are mapped back onto it.
  width: number
  height: number
  streaming: boolean
}

let mirror: Mirror | null = null
// How many views in the app are showing frames right now; the stream runs
// only while someone is looking.
let viewers = 0
// A screencast sends a frame when the page paints and nothing when it is
// still. A page mid-render sends its half-drawn state and then goes quiet,
// which leaves that half-drawn state on screen looking like a dead page. So
// while someone is watching, a still page is photographed now and then and
// the picture goes out as a frame like any other.
const QUIET_MS = 2_500
let poke: ReturnType<typeof setInterval> | null = null

// sharp: every device pixel the page was drawn with, for the view a person
// is reading. Otherwise one pixel per CSS pixel, which is what the run of
// frames carries and costs a third as much.
async function shoot(m: Mirror, sharp = false): Promise<void> {
  if (!sharp && (Date.now() - m.painted < QUIET_MS || m.shooting)) return
  if (m.shooting) return
  m.shooting = true
  try {
    const shot = await m.page.screenshot({ type: 'jpeg', quality: sharp ? 78 : 60, scale: sharp ? 'device' : 'css', fullPage: false, timeout: 6_000 })
    if (mirror !== m) return
    m.painted = Date.now()
    broadcast({ type: 'agent:frame', data: shot.toString('base64'), width: m.width, height: m.height, url: m.page.url() })
  } catch {
    // A page that will not be photographed (navigating, closed) is left to
    // the next round.
  } finally {
    m.shooting = false
  }
}

function watchForStillness(): void {
  if (poke) return
  poke = setInterval(() => {
    const m = mirror
    if (!m || viewers === 0) return
    void shoot(m)
  }, QUIET_MS).unref()
}

function stopWatchingForStillness(): void {
  if (!poke) return
  clearInterval(poke)
  poke = null
}

function say(on: boolean): void {
  broadcast({ type: 'agent:live', on, ...(on && mirror ? { url: mirror.page.url() } : {}) })
}

async function stream(m: Mirror, on: boolean): Promise<void> {
  if (m.streaming === on) return
  m.streaming = on
  await m.cdp.send(on ? 'Page.startScreencast' : 'Page.stopScreencast', on ? { ...FRAME } : {}).catch(() => undefined)
}

async function drop(): Promise<void> {
  const m = mirror
  if (!m) return
  mirror = null
  await stream(m, false)
  await m.cdp.detach().catch(() => undefined)
}

async function follow(page: Page): Promise<void> {
  await drop()
  let cdp: CDPSession
  try {
    cdp = await page.context().newCDPSession(page)
  } catch {
    return
  }
  const size = page.viewportSize() ?? { width: 1280, height: 800 }
  const m: Mirror = { page, cdp, width: size.width, height: size.height, streaming: false, painted: 0, shooting: false }
  mirror = m
  cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    if (mirror !== m) return
    m.width = frame.metadata.deviceWidth || m.width
    m.height = frame.metadata.deviceHeight || m.height
    m.painted = Date.now()
    broadcast({ type: 'agent:frame', data: frame.data, width: m.width, height: m.height, url: page.url() })
  })
  // Where the page has got to, said whether or not anyone wants frames: a
  // folded view shows the address alone, and it has to stay true.
  page.on('framenavigated', (frame) => {
    if (mirror === m && frame === page.mainFrame()) say(true)
  })
  page.on('close', () => {
    if (mirror !== m) return
    void drop().then(() => {
      // The tab that closed may have been a popup over the one that opened
      // it; the mirror falls back to the latest that is still there.
      const rest = agentPages()
      const next = rest[rest.length - 1]
      if (next) void follow(next)
      else say(false)
    })
  })
  say(true)
  if (viewers > 0) await stream(m, true)
}

// Wired once at startup: every page the agent browser opens is mirrored as
// it appears — the newest tab is the one the person needs to see.
export function startAgentView(): void {
  watchAgentPages((page) => void follow(page))
}

export async function watchAgentView(on: boolean): Promise<{ on: boolean; url?: string }> {
  viewers = Math.max(0, viewers + (on ? 1 : -1))
  if (viewers > 0) watchForStillness()
  else stopWatchingForStillness()
  if (mirror) await stream(mirror, viewers > 0)
  return mirror ? { on: true, url: mirror.page.url() } : { on: false }
}

// The picture again, now, whatever the page is doing: what a person presses
// when the view has gone still on a half-drawn page, and what the large view
// asks for when it opens - there, every pixel the page was drawn with.
export async function refreshAgentView(sharp = false): Promise<void> {
  const m = mirror
  if (!m) return
  m.painted = 0
  await shoot(m, sharp)
}

// Whether a window is being mirrored, asked without joining the watch: a
// view that shows only the address needs this and no frames at all.
export function agentViewState(): { on: boolean; url?: string } {
  return mirror ? { on: true, url: mirror.page.url() } : { on: false }
}

const BUTTON = { left: 'left', right: 'right', middle: 'middle', none: 'none' } as const

export async function agentViewInput(input: AgentInputDto): Promise<void> {
  const m = mirror
  if (!m) return
  try {
    if (input.kind === 'mouse') {
      const x = Math.round(Math.min(1, Math.max(0, input.x)) * m.width)
      const y = Math.round(Math.min(1, Math.max(0, input.y)) * m.height)
      const type = ({ pressed: 'mousePressed', released: 'mouseReleased', moved: 'mouseMoved', wheel: 'mouseWheel' } as const)[input.type]
      await m.cdp.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: BUTTON[input.button ?? 'none'],
        clickCount: input.clicks ?? 0,
        modifiers: input.modifiers ?? 0,
        ...(input.type === 'wheel' ? { deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 } : {}),
      })
    } else if (input.kind === 'key') {
      // A key with text behind it is typed; one without (an arrow, a
      // backspace, a shortcut) is only pressed.
      await m.cdp.send('Input.dispatchKeyEvent', {
        type: input.type === 'up' ? 'keyUp' : input.text ? 'keyDown' : 'rawKeyDown',
        key: input.key,
        code: input.code,
        windowsVirtualKeyCode: input.keyCode,
        nativeVirtualKeyCode: input.keyCode,
        modifiers: input.modifiers ?? 0,
        ...(input.type === 'down' && input.text ? { text: input.text, unmodifiedText: input.text } : {}),
      })
    } else {
      await m.cdp.send('Input.insertText', { text: input.text })
    }
  } catch (err) {
    flog('agent-view', `input failed: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
  }
}

// An address typed on the mirror: the page goes there as if it had been
// typed in the window's own bar, so a lesson can begin from a blank tab.
export async function agentViewGo(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  // An address typed with no window behind it - the card frozen on the last
  // thing a closed browser showed - opens one and goes there.
  const m = mirror ?? (await ensureAgentPage().then(() => mirror).catch(() => null))
  if (!m) return
  await m.page.goto(url, { waitUntil: 'commit' }).catch((err: unknown) => {
    flog('agent-view', `go failed: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
  })
}

// The real window, brought onto the desk when the mirror is not enough
// (a browser dialog, a download, a page that will not draw) and parked
// again after; parked, it still paints, so the mirror keeps up.
export async function showAgentWindow(show: boolean): Promise<void> {
  const m = mirror
  if (!m) return
  try {
    const { windowId } = (await m.cdp.send('Browser.getWindowForTarget')) as { windowId: number }
    await m.cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...(show ? ON_SCREEN : OFF_SCREEN), windowState: 'normal' } })
    if (show) await m.page.bringToFront().catch(() => undefined)
  } catch (err) {
    flog('agent-view', `window move failed: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
  }
}
