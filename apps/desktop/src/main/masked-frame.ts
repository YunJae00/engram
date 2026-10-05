import { nativeImage } from 'electron'
import { evidenceRegion } from 'core'
import type { Page } from 'playwright-core'
import { SECRET_FIELDS } from './page-mask.js'

// Both automatic and explicitly requested evidence fail closed if a document
// or frame changes while the masked screenshot is being taken.
export async function maskedFrame(page: Page, origin: string, masks: string[], signal?: AbortSignal, region?: unknown, format: 'png' | 'jpeg' = 'png', quality = 80): Promise<Buffer> {
  signal?.throwIfAborted()
  const url = page.url()
  if (page.isClosed() || !/^https?:/.test(url) || new URL(url).origin !== origin) throw new Error('The recorded tab closed or left the approved site.')
  let changed = false
  const change = () => { changed = true }
  page.on('framenavigated', change); page.on('frameattached', change); page.on('framedetached', change)
  const take = async () => {
    const frames = page.frames()
    const addresses = frames.map(frame => frame.url())
    // Failure to inspect any frame must not fall back to an unmasked image.
    for (const frame of frames) await frame.locator('html').count()
    for (const selector of masks) {
      const counts = await Promise.all(frames.map(frame => frame.locator(selector).count()))
      if (!counts.some(Boolean)) throw new Error('A requested redaction target is missing. Recording stopped before capturing it.')
    }
    signal?.throwIfAborted()
    if (changed) throw new Error('The page changed while preparing evidence.')
    const data = await page.screenshot({ type: format, ...(format === 'jpeg' ? { quality } : {}), fullPage: false, scale: 'css', timeout: 8000, mask: frames.flatMap(frame => [frame.locator(SECRET_FIELDS), ...masks.map(selector => frame.locator(selector))]), maskColor: '#202020' })
    signal?.throwIfAborted()
    const current = page.frames()
    if (changed || page.isClosed() || page.url() !== url || frames.length !== current.length || frames.some((frame, i) => current[i] !== frame || frame.isDetached() || frame.url() !== addresses[i])) throw new Error('The page changed while capturing evidence.')
    if (!region) return data
    const image = nativeImage.createFromBuffer(data)
    const size = image.getSize()
    const cropped = image.crop(evidenceRegion(region, size.width, size.height)!)
    return format === 'jpeg' ? cropped.toJPEG(quality) : cropped.toPNG()
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => { changed = true; reject(new Error('Recording capture canceled')) }
      signal?.addEventListener('abort', abort, { once: true })
      timeout = setTimeout(() => { changed = true; reject(new Error('Recording capture timed out')) }, 8000)
    })
    return await Promise.race([take(), canceled])
  } finally {
    clearTimeout(timeout)
    if (abort) signal?.removeEventListener('abort', abort)
    page.off('framenavigated', change); page.off('frameattached', change); page.off('framedetached', change)
  }
}
