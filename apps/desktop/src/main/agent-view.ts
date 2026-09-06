import type { CDPSession, Frame, Page } from 'playwright-core'
import type { AgentInputDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import { activeLaneName, ensureAgentPage, lanePage, laneOf, resetLane, setActiveLane, watchAgentPages } from './agent-browser.js'
import { setPointerSink } from './page-actions.js'
import { flog } from './flog.js'
import { captureSharpFrame, startPagePreview } from './page-preview.js'

// The agent's window stays out of sight. What it shows is mirrored into the
// app as a run of small frames, and what the person does on the mirror —
// a sign-in, a robot check, a lesson — is played back into the window as
// their own clicks and keys. Frames go to the screen and nowhere else: none
// is written, logged or kept past the next one.

const ON_SCREEN = { left: 120, top: 80 }
const OFF_SCREEN = { left: -4000, top: -4000 }

interface Mirror {
  previewStop?: () => void
  cleanup?: () => void
  page: Page
  cdp: CDPSession
  // When a frame last went out, and whether a photograph is being taken.
  painted: number
  shooting: boolean
  // Whose picture this is: the lane the mirrored page belongs to.
  lane: string
  // A picture asked for while one was being taken: taken again after.
  again: boolean
  // The page's own size, which the frame is a scaled copy of; pointer
  // positions arrive as fractions and are mapped back onto it.
  width: number
  height: number
  streaming: boolean
  streamRevision: number
}

let mirror: Mirror | null = null
// How many views in the app are showing frames right now; the stream runs
// only while someone is looking.
let viewers = 0
const QUIET_MS = 1_500

// A photograph of the page as it stands, at every pixel it was drawn with.
// `now` takes one whether or not the page has settled - what a person asks
// for by hand, or what the view wants the moment it opens; without it the
// picture is only taken of a page that has been quiet long enough to be
// worth the cost.
async function shoot(m: Mirror, now = false): Promise<void> {
  if (!now && Date.now() - m.painted < QUIET_MS) return
  if (m.shooting) {
    // A picture wanted now, while one is on its way, is not dropped: it is
    // taken as soon as this one lands, or the page that just changed shape
    // stays on screen in its old one.
    if (now) m.again = true
    return
  }
  m.shooting = true
  try {
    const revision = m.painted
    const shot = await captureSharpFrame(m.page, m.cdp)
    if (mirror !== m || revision !== m.painted) return
    m.painted = Date.now()
    m.width = shot.width
    m.height = shot.height
    broadcast({ type: 'agent:frame', ...shot, url: m.page.url(), lane: m.lane })
  } catch (err) {
    // A page that will not be photographed (navigating, closed) is left to
    // the next round - but said, because a picture that never comes is
    // otherwise indistinguishable from a page that never changed.
    flog('agent-view', `still not taken: ${String(err instanceof Error ? err.message : err).slice(0, 140)}`)
  } finally {
    m.shooting = false
    if (m.again) {
      m.again = false
      void shoot(m, true)
    }
  }
}

function say(on: boolean): void {
  broadcast({ type: 'agent:live', on, lane: activeLaneName(), ...(on && mirror ? { url: mirror.page.url(), lane: mirror.lane } : {}) })
}

async function stream(m: Mirror, on: boolean): Promise<void> {
  if (m.streaming === on) return
  m.streaming = on
  const revision = ++m.streamRevision
  if (!on) { m.previewStop?.(); m.previewStop = undefined; return }
  try {
    const stop = await startPagePreview(m.page, (frame) => {
      if (mirror !== m || !m.streaming || revision !== m.streamRevision) return
      m.width = frame.width
      m.height = frame.height
      m.painted = Date.now()
      broadcast({ type: 'agent:frame', ...frame, url: m.page.url(), lane: m.lane })
    })
    if (mirror !== m || !m.streaming || revision !== m.streamRevision) stop()
    else m.previewStop = stop
  } catch (err) {
    flog('agent-view', `stream failed on ${m.page.url()}: ${err instanceof Error ? err.message : String(err)}`)
    if (revision === m.streamRevision) m.streaming = false
  }
}

async function drop(): Promise<void> {
  const m = mirror
  if (!m) return
  mirror = null
  m.cleanup?.()
  await stream(m, false)
  await m.cdp.detach().catch(() => undefined)
}

// The follow under way, so a caller that has just opened a page can wait
// for its mirror instead of finding none there yet.
let following: Promise<void> = Promise.resolve()
let followGeneration = 0

function follow(page: Page): Promise<void> {
  const generation = ++followGeneration
  following = following.catch(() => undefined).then(async () => {
    if (generation !== followGeneration || laneOf(page) !== activeLaneName() || page.isClosed()) return
    await followNow(page, generation)
  })
  return following
}

async function followNow(page: Page, generation: number): Promise<void> {
  await drop()
  let cdp: CDPSession
  try {
    cdp = await page.context().newCDPSession(page)
  } catch {
    return
  }
  if (generation !== followGeneration || laneOf(page) !== activeLaneName() || page.isClosed()) {
    await cdp.detach().catch(() => undefined)
    return
  }
  const size = page.viewportSize() ?? { width: 1280, height: 860 }
  const m: Mirror = { page, cdp, lane: laneOf(page) ?? activeLaneName(), width: size.width, height: size.height, streaming: false, streamRevision: 0, painted: 0, shooting: false, again: false }
  mirror = m
  // Where the page has got to, said whether or not anyone wants frames: a
  // folded view shows the address alone, and it has to stay true.
  const navigated = (frame: Frame) => {
    if (mirror === m && frame === page.mainFrame()) say(true)
  }
  const closed = () => {
    if (mirror !== m) return
    void drop().then(() => {
      // The tab that closed may have been a popup over the one that opened
      // it; the mirror falls back to whatever the lane still holds.
      const next = lanePage(activeLaneName())
      if (next) void follow(next)
      else say(false)
    })
  }
  page.on('framenavigated', navigated)
  page.on('close', closed)
  m.cleanup = () => {
    page.off('framenavigated', navigated)
    page.off('close', closed)
  }
  say(true)
  if (viewers > 0) await stream(m, true)
}

// Wired once at startup: every page the agent browser opens is mirrored as
// it appears — the newest tab is the one the person needs to see.
export function startAgentView(): void {
  // Only the lane being looked at is mirrored: another comet's tab paints
  // in the background and costs no frames until it is looked at.
  watchAgentPages((page, lane) => {
    if (lane === activeLaneName()) void follow(page)
  })
  // The comet's hand, shown on the picture of the page it is on.
  setPointerSink((page, x, y, kind) => {
    if (mirror?.page === page) broadcast({ type: 'agent:pointer', x, y, kind })
  })
}

// When the person last put their own hands on a lane's page - a press or
// a key, not a look or a scroll. A comet working on that page steps aside
// while the hands are there, and carries on once they have been still.
const touched = new Map<string, number>()

export function touchedAt(lane: string): number {
  return touched.get(lane) ?? 0
}

// The person looks at another comet: the mirror moves to that comet's tab,
// or shows nothing if it has none yet.
export async function lookAtLane(lane: string): Promise<{ on: boolean; url?: string }> {
  setActiveLane(lane)
  const page = lanePage(lane)
  if (mirror?.page === page && page) return { on: true, url: page.url() }
  if (page) {
    await follow(page)
    if (mirror?.page === page) void shoot(mirror, true)
    return { on: true, url: page.url() }
  }
  ++followGeneration
  await drop()
  say(false)
  return { on: false }
}

// The lane's tab is closed and the mirror goes dark; the next ask opens a
// fresh page.
export async function resetLaneView(lane: string): Promise<void> {
  const page = lanePage(lane)
  if (page && mirror?.page === page) await drop()
  await resetLane(lane)
  if (lane === activeLaneName()) say(false)
}

// What a lane's tab is showing, for a turn that starts on it.
export function laneState(lane: string): { on: boolean; url?: string } {
  const page = lanePage(lane)
  return page ? { on: true, url: page.url() } : { on: false }
}

export async function watchAgentView(on: boolean): Promise<{ on: boolean; url?: string }> {
  viewers = Math.max(0, viewers + (on ? 1 : -1))
  if (mirror) await stream(mirror, viewers > 0)
  return mirror ? { on: true, url: mirror.page.url() } : { on: false }
}

// The picture again, now, whatever the page is doing: what a person presses
// when the view has gone still on a half-drawn page, and what a view asks for
// the moment it opens.
export async function refreshAgentView(): Promise<void> {
  const m = mirror
  if (!m) return
  await shoot(m, true)
}

// Whether a window is being mirrored, asked without joining the watch: a
// view that shows only the address needs this and no frames at all.
export function agentViewState(): { on: boolean; url?: string; lane?: string } {
  return mirror ? { on: true, url: mirror.page.url(), lane: mirror.lane } : { on: false }
}

const BUTTON = { left: 'left', right: 'right', middle: 'middle', none: 'none' } as const

export async function agentViewInput(input: AgentInputDto, lane: string): Promise<void> {
  const m = mirror
  if (!m || m.lane !== lane || activeLaneName() !== lane) return
  const hands = input.kind === 'key' || input.kind === 'text' || (input.kind === 'mouse' && (input.type === 'pressed' || input.type === 'released'))
  if (hands) touched.set(laneOf(m.page) ?? activeLaneName(), Date.now())
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
export async function agentViewGo(url: string, lane = activeLaneName()): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return
  // An address typed with no window behind it - the card frozen on the last
  // thing a closed browser showed - opens one and goes there.
  // A page opened for this has its mirror attached a moment after it
  // exists; going somewhere before that would go nowhere at all.
  const page = await ensureAgentPage(lane).catch(() => null)
  if (!page) return
  await page.goto(url, { waitUntil: 'commit' }).catch((err: unknown) => {
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
