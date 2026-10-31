import type { CDPSession, Page } from 'playwright-core'
import { flog } from './flog.js'
import { createPreviewPool } from './preview-pool.js'
import { serialWork } from './serial-work.js'
import { macBrowserScale } from './browser-macos.js'

export interface PreviewFrame { data: string; width: number; height: number }
interface CastFrame { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }

const captures = new WeakMap<Page, Promise<PreviewFrame>>()
const restoredAt = new WeakMap<Page, number>()
const pageWork = new WeakMap<Page, ReturnType<typeof serialWork>>()
function workFor(page: Page): ReturnType<typeof serialWork> {
  let work = pageWork.get(page)
  if (!work) { work = serialWork(); pageWork.set(page, work) }
  return work
}

export function withPreviewInput<T>(page: Page, input: () => Promise<T>): Promise<T> {
  return workFor(page).run(async () => {
    const remaining = (restoredAt.get(page) ?? 0) - Date.now()
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    return input()
  })
}

// A screenshot temporarily resizes the compositor; its restore must finish
// before a real viewport update, or it can put the old dimensions back.
export function resizePreview(page: Page, size: { width: number; height: number }): Promise<boolean> {
  return withPreviewInput(page, async () => {
    const current = page.viewportSize()
    if (current?.width === size.width && current.height === size.height) return false
    await page.setViewportSize(size)
    return true
  })
}

async function capture(page: Page): Promise<PreviewFrame> {
  const size = page.viewportSize() ?? { width: 1280, height: 860 }
  // Use the page's owning session: another CDP session restores its own empty
  // emulation settings after capture, overwriting the page's device scale.
  const scale = macBrowserScale(page.context())
  const shot = scale === undefined
    ? await page.screenshot({ type: 'png', scale: 'device', caret: 'initial', timeout: 5000 })
    : await captureScaled(page, size, scale)
  const current = page.viewportSize()
  if (current && (current.width !== size.width || current.height !== size.height)) {
    throw new Error('Browser viewport changed during capture')
  }
  return { data: shot.toString('base64'), ...size }
}

async function captureScaled(page: Page, size: { width: number; height: number }, scale: number): Promise<Buffer> {
  const session = await page.context().newCDPSession(page)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // CDP-attached contexts have no device scale option; scale the capture, not the page layout.
    const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Browser preview capture timed out')), 5000) })
    const metrics = await Promise.race([session.send('Page.getLayoutMetrics'), expired])
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
    const origin = { x: viewport?.pageX ?? 0, y: viewport?.pageY ?? 0 }
    const take = async (factor: number) => {
      const result = await Promise.race([session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { ...origin, ...size, scale: factor } }), expired])
      const image = Buffer.from(result.data, 'base64')
      if (image.length < 24 || image.readUInt32BE(16) === 0) throw new Error('Browser preview returned an invalid PNG')
      return image
    }
    const image = await take(1)
    const wanted = Math.round(size.width * scale)
    return image.readUInt32BE(16) === wanted ? image : await take(wanted / image.readUInt32BE(16))
  } finally { clearTimeout(timer); await session.detach().catch(() => undefined) }
}

export function captureSharpFrame(page: Page): Promise<PreviewFrame> {
  const held = captures.get(page)
  if (held) return held
  const pending = workFor(page).run(async () => {
    try { return await capture(page) }
    finally { restoredAt.set(page, Date.now() + 60) }
  }).finally(() => { captures.delete(page) })
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
      const shot = await captureSharpFrame(page)
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
  // Bound motion bandwidth; the settled frame retains lossless text detail.
  const CAST = { format: 'jpeg', quality: 80, maxWidth: 1920, maxHeight: 2400, everyNthFrame: 1 } as const
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
    clearTimeout(motionTimer)
    motionFrame = undefined
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
    const delay = 33 - (changed - sent)
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
  let shape = JSON.stringify(page.viewportSize())
  const timer = setInterval(() => {
    const next = JSON.stringify(page.viewportSize())
    if (next !== shape) { shape = next; recast() }
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
