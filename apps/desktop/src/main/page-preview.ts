import type { CDPSession, Page } from 'playwright-core'
import { flog } from './flog.js'
import { createPreviewPool } from './preview-pool.js'

export interface PreviewFrame { data: string; width: number; height: number }
interface CastFrame { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }

// Keyed by page, not session: the pull API opens a fresh session per ask,
// and a session-keyed cache would probe the scale again on every one.
const captureScales = new WeakMap<Page, number>()
const captures = new WeakMap<Page, Promise<PreviewFrame>>()
const restoredAt = new WeakMap<Page, number>()

async function capture(page: Page, cdp: CDPSession): Promise<PreviewFrame> {
  const size = page.viewportSize() ?? { width: 1280, height: 860 }
  const metrics = await cdp.send('Page.getLayoutMetrics')
  const viewport = metrics.visualViewport ?? { pageX: 0, pageY: 0, scale: 1 }
  let scale = captureScales.get(page) ?? 0
  const zoom = viewport.scale || 1
  // A scaled clip needs a larger render surface, otherwise its outer area is white.
  const capture = () => cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: Boolean(scale),
    ...(scale ? { clip: { x: viewport.pageX, y: viewport.pageY, width: size.width / zoom, height: size.height / zoom, scale: scale * zoom } } : {}),
  })
  let shot = await capture()
  // CDP sessions do not all inherit the context's device scale. Measure
  // the PNG rather than upscaling a low-resolution bitmap on the canvas.
  if (shot.data.startsWith('iVBOR')) {
    const width = Buffer.from(shot.data, 'base64').readUInt32BE(16)
    if (width > 0 && width < size.width * 2) {
      scale = (scale || 1) * size.width * 2 / width
      captureScales.set(page, scale)
      shot = await capture()
    }
  }
  return { data: shot.data, ...size }
}

export function captureSharpFrame(page: Page, cdp: CDPSession): Promise<PreviewFrame> {
  const held = captures.get(page)
  if (held) return held
  const pending = capture(page, cdp).finally(() => {
    captures.delete(page)
    restoredAt.set(page, Date.now() + 60)
  })
  captures.set(page, pending)
  return pending
}

// The stream carries motion. A lossless, device-resolution still replaces
// it after painting settles, so small text does not stay JPEG-compressed.
async function openPagePreview(page: Page, receive: (frame: PreviewFrame) => void): Promise<() => Promise<void>> {
  const cdp: CDPSession = await page.context().newCDPSession(page)
  let alive = true
  let changed = 0
  let sent = 0
  let motionTimer: ReturnType<typeof setTimeout> | undefined
  let motionFrame: PreviewFrame | undefined
  const sendMotion = () => {
    motionTimer = undefined
    const frame = motionFrame
    motionFrame = undefined
    if (!alive || !frame) return
    sent = Date.now()
    receive(frame)
  }
  let settled = false
  let capturing = false
  let recovering: ReturnType<typeof setTimeout> | undefined
  let pendingFrame: CastFrame | undefined
  let lastStream = ''
  let stillFails = 0
  const recover = () => {
    if (!alive || recovering) return
    recovering = setTimeout(() => {
      recovering = undefined
      if (capturing || captures.has(page) || Date.now() < (restoredAt.get(page) ?? 0)) { recover(); return }
      const latest = pendingFrame
      pendingFrame = undefined
      if (alive && latest) deliver(latest)
    }, 60).unref()
  }
  const still = async () => {
    if (!alive || capturing || recovering) return
    capturing = true
    const revision = changed
    try {
      const shot = await captureSharpFrame(page, cdp)
      if (alive && revision === changed) {
        receive(shot)
        settled = true
      }
    } catch (err) {
      if (++stillFails <= 3) flog('page-preview', `still failed on ${page.url()}: ${err instanceof Error ? err.message : String(err)}`)
      settled = false
    } finally {
      capturing = false
      // A screenshot temporarily changes the compositor surface. Coalesce
      // its restore frames before comparing them with the last live frame.
      recover()
    }
  }
  const CAST = { format: 'jpeg', quality: 94, maxWidth: 2560, maxHeight: 4400, everyNthFrame: 1 } as const
  // A screencast survives the page being laid out to a new shape but goes on
  // delivering surfaces of the OLD shape (measured, whether the layout came
  // before or after the cast began), so the cast is begun again whenever a
  // frame contradicts the viewport, and a fresh still follows.
  let recastAt = 0
  const recast = () => {
    const now = Date.now()
    if (now - recastAt < 1000) return
    recastAt = now
    changed = now
    settled = false
    lastStream = ''
    void cdp.send('Page.stopScreencast').then(() => (alive ? cdp.send('Page.startScreencast', CAST) : undefined)).catch(() => undefined)
  }
  const deliver = (frame: CastFrame) => {
    const size = page.viewportSize()
    // A frame of the wrong shape is the stale surface: it must not reach the
    // screen, and it must not count as the page changing, or it starves the
    // still that would carry the true picture.
    if (size && Math.abs(frame.metadata.deviceWidth * size.height - frame.metadata.deviceHeight * size.width) > 0.02 * frame.metadata.deviceHeight * size.width) {
      recast()
      return
    }
    if (frame.data === lastStream) return
    lastStream = frame.data
    changed = Date.now()
    settled = false
    // Input against the mirror is dispatched in CSS pixels scaled by these
    // numbers, so every frame reports the page's CSS size regardless of how
    // many device pixels the bitmap itself carries.
    motionFrame = { data: frame.data, ...(size ?? { width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight }) }
    const delay = 16 - (changed - sent)
    if (delay > 0) {
      if (!motionTimer) motionTimer = setTimeout(sendMotion, delay).unref()
    } else {
      clearTimeout(motionTimer)
      sendMotion()
    }
  }
  cdp.on('Page.screencastFrame', (frame: CastFrame) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
    if (!alive) return
    if (capturing || recovering || captures.has(page) || Date.now() < (restoredAt.get(page) ?? 0)) {
      pendingFrame = frame
      recover()
      return
    }
    deliver(frame)
  })
  const navigated = () => { changed = Date.now(); settled = false }
  page.on('framenavigated', navigated)
  page.on('domcontentloaded', navigated)
  const timer = setInterval(() => {
    if (!settled && Date.now() - changed > 300) void still()
  }, 150).unref()
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    alive = false
    clearInterval(timer)
    clearTimeout(recovering)
    clearTimeout(motionTimer)
    motionFrame = undefined
    pendingFrame = undefined
    page.off('framenavigated', navigated)
    page.off('domcontentloaded', navigated)
    page.off('close', stop)
    stopping = cdp.send('Page.stopScreencast').catch(() => undefined).then(() => cdp.detach().catch(() => undefined))
    return stopping
  }
  page.once('close', stop)
  try {
    await cdp.send('Page.startScreencast', CAST)
    void still()
  } catch (error) { await stop(); throw error }
  return stop
}

export const startPagePreview = createPreviewPool<Page, PreviewFrame>(openPagePreview)
