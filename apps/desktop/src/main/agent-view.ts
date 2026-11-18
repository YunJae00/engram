import type { CDPSession, Frame, Page } from 'playwright-core'
import type { AgentInputDto } from '../shared/types.js'
import { broadcast } from './engine-health.js'
import { activeLaneName, ensureAgentPage, lanePage, laneOf, resetLane, setActiveLane, watchAgentPages } from './agent-browser.js'
import { setPointerSink } from './page-actions.js'
import { flog } from './flog.js'
import { captureSharpFrame, startPagePreview, withPreviewInput } from './page-preview.js'
import { isNativePage, setNativeInputSink } from './native-browser.js'

const ON_SCREEN = { left: 120, top: 80 }
const OFF_SCREEN = { left: -4000, top: -4000 }

interface Mirror {
  previewStop?: () => void
  cleanup?: () => void
  page: Page
  cdp: CDPSession
  painted: number
  shooting: boolean
  lane: string
  again: boolean
  width: number
  height: number
  streaming: boolean
  streamRevision: number
}

let mirror: Mirror | null = null
let viewers = 0
const QUIET_MS = 1_500

async function shoot(m: Mirror, now = false): Promise<void> {
  if (isNativePage(m.page)) return
  if (!now && Date.now() - m.painted < QUIET_MS) return
  if (m.shooting) {
    if (now) m.again = true
    return
  }
  m.shooting = true
  try {
    const revision = m.painted
    const shot = await captureSharpFrame(m.page)
    if (mirror !== m || revision !== m.painted) return
    m.painted = Date.now()
    m.width = shot.width
    m.height = shot.height
    broadcast({ type: 'agent:frame', ...shot, url: m.page.url(), lane: m.lane })
  } catch (err) {
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
  if (isNativePage(m.page)) return
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

let following: Promise<void> = Promise.resolve()
let followGeneration = 0

function follow(page: Page): Promise<void> {
  if (page !== lanePage(activeLaneName())) return Promise.resolve()
  const generation = ++followGeneration
  following = following.catch(() => undefined).then(async () => {
    if (generation !== followGeneration || page !== lanePage(activeLaneName()) || page.isClosed()) return
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
  if (generation !== followGeneration || page !== lanePage(activeLaneName()) || page.isClosed()) {
    await cdp.detach().catch(() => undefined)
    return
  }
  const size = page.viewportSize() ?? { width: 1280, height: 860 }
  const m: Mirror = { page, cdp, lane: laneOf(page) ?? activeLaneName(), width: size.width, height: size.height, streaming: false, streamRevision: 0, painted: 0, shooting: false, again: false }
  mirror = m
  const navigated = (frame: Frame) => {
    if (mirror === m && frame === page.mainFrame()) say(true)
  }
  const closed = () => {
    if (mirror !== m) return
    void drop().then(() => {
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

export function startAgentView(): void {
  setNativeInputSink((page) => {
    const lane = laneOf(page)
    if (lane) touched.set(lane, Date.now())
  })
  watchAgentPages((page, lane) => {
    if (lane === activeLaneName()) void follow(page)
  })
  setPointerSink((page, x, y, kind) => {
    if (mirror?.page === page) broadcast({ type: 'agent:pointer', x, y, kind })
  })
}

const touched = new Map<string, number>()

export function touchedAt(lane: string): number {
  return touched.get(lane) ?? 0
}

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

export async function resetLaneView(lane: string): Promise<void> {
  const page = lanePage(lane)
  if (page && mirror?.page === page) await drop()
  await resetLane(lane)
  if (lane === activeLaneName()) say(false)
}

export function laneState(lane: string): { on: boolean; url?: string } {
  const page = lanePage(lane)
  return page ? { on: true, url: page.url() } : { on: false }
}

export async function watchAgentView(on: boolean): Promise<{ on: boolean; url?: string }> {
  viewers = Math.max(0, viewers + (on ? 1 : -1))
  if (mirror) await stream(mirror, viewers > 0)
  return mirror ? { on: true, url: mirror.page.url() } : { on: false }
}

export async function refreshAgentView(): Promise<void> {
  const m = mirror
  if (!m) return
  if (isNativePage(m.page)) { await m.page.reload({ waitUntil: 'commit' }); return }
  await shoot(m, true)
}

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
    await withPreviewInput(m.page, async () => {
      if (mirror !== m || activeLaneName() !== lane || m.page.isClosed()) return
      if (input.kind === 'mouse') {
        const size = m.page.viewportSize() ?? { width: m.width, height: m.height }
        const x = Math.round(Math.min(1, Math.max(0, input.x)) * size.width)
        const y = Math.round(Math.min(1, Math.max(0, input.y)) * size.height)
        const type = ({ pressed: 'mousePressed', released: 'mouseReleased', moved: 'mouseMoved', wheel: 'mouseWheel' } as const)[input.type]
        const painted = () => m.page.evaluate(() => new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 100)
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() }))
        }))
        if (input.type === 'wheel') {
          await m.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers: input.modifiers ?? 0 })
          await painted()
          if (mirror !== m || activeLaneName() !== lane || m.page.isClosed()) return
        }
        await m.cdp.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: BUTTON[input.button ?? 'none'],
          clickCount: input.clicks ?? 0,
          modifiers: input.modifiers ?? 0,
          ...(input.type === 'wheel' ? { deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 } : {}),
        })
        if (input.type === 'wheel') await painted()
      } else if (input.kind === 'key') {
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
    })
    if (input.kind === 'mouse' && input.type === 'wheel' && mirror === m && activeLaneName() === lane) await shoot(m, true)
  } catch (err) {
    flog('agent-view', `input failed: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
  }
}

export async function agentViewGo(url: string, lane = activeLaneName()): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter an http or https website address.')
  const address = new URL(url)
  if (address.username || address.password) throw new Error('Do not include credentials in a website address.')
  const page = await ensureAgentPage(lane)
  await page.goto(address.href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err: unknown) => {
    flog('agent-view', `go failed: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
    throw err
  })
}

export async function showAgentWindow(show: boolean): Promise<void> {
  const m = mirror
  if (!m) return
  if (isNativePage(m.page) || process.platform === 'darwin') return
  try {
    const { windowId } = (await m.cdp.send('Browser.getWindowForTarget')) as { windowId: number }
    await m.cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...(show ? ON_SCREEN : OFF_SCREEN), windowState: 'normal' } })
    if (show) await m.page.bringToFront().catch(() => undefined)
  } catch (err) {
    flog('agent-view', `window move failed: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`)
  }
}
