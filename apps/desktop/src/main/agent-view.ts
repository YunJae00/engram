import type { CDPSession, Page } from 'playwright-core'
import type { AgentInputDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import { agentPages, watchAgentPages } from './agent-browser.js'
import { flog } from './flog.js'

// The agent's window stays out of sight. What it shows is mirrored into the
// app as a run of small frames, and what the person does on the mirror —
// a sign-in, a robot check, a lesson — is played back into the window as
// their own clicks and keys. Frames go to the screen and nowhere else: none
// is written, logged or kept past the next one.

const FRAME = { format: 'jpeg', quality: 55, maxWidth: 960, maxHeight: 600 } as const
const ON_SCREEN = { left: 120, top: 80 }
const OFF_SCREEN = { left: -4000, top: -4000 }

interface Mirror {
  page: Page
  cdp: CDPSession
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
  const size = page.viewportSize() ?? { width: 1440, height: 900 }
  const m: Mirror = { page, cdp, width: size.width, height: size.height, streaming: false }
  mirror = m
  cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    if (mirror !== m) return
    m.width = frame.metadata.deviceWidth || m.width
    m.height = frame.metadata.deviceHeight || m.height
    broadcast({ type: 'agent:frame', data: frame.data, width: m.width, height: m.height, url: page.url() })
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
  if (mirror) await stream(mirror, viewers > 0)
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
  const m = mirror
  if (!m || !/^https?:\/\//i.test(url)) return
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
