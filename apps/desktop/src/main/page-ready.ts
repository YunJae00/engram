import type { WebPage } from 'core'
import type { Page } from 'playwright-core'

export async function readWhenReady(page: Page, read: (signal?: AbortSignal) => Promise<WebPage>, signal?: AbortSignal): Promise<WebPage> {
  if (signal?.aborted) throw new Error('stopped')
  const controller = new AbortController()
  const readingSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancel: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The browser did not finish reading within 45 seconds. Reopen or inspect the page with browser tools; its content has not been verified.')), 45_000)
    cancel = () => reject(new Error('stopped'))
    signal?.addEventListener('abort', cancel, { once: true })
  })
  try {
    return await Promise.race([readUntilReady(page, read, readingSignal), interrupted])
  } finally {
    controller.abort()
    clearTimeout(timer)
    if (cancel) signal?.removeEventListener('abort', cancel)
  }
}

const THIN_CHARS = 200
const QUIET_MS = 1_500

const ownParts = (page: Page): Promise<number> =>
  Promise.resolve().then(() => page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => {
    try { return new URL(entry.name).host === location.host } catch { return false }
  }).length)).catch(() => -1)

async function readUntilReady(page: Page, read: (signal?: AbortSignal) => Promise<WebPage>, signal?: AbortSignal): Promise<WebPage> {
  const started = Date.now()
  const deadline = started + 12_000, last = started + 30_000
  let wait = 400, parts = -1, grew = started
  while (true) {
    if (signal?.aborted) throw new Error('stopped')
    const result = await read(signal)
    if (signal?.aborted) throw new Error('stopped')
    const words = result.text.trim()
    const said = !!words && !/^(loading|please wait)[.\s…]*$/i.test(words)
    if (result.wall) return result
    const thin = (said || !!result.controls?.length) && words.length < THIN_CHARS
    if (said && !thin) return result
    const before = parts
    parts = await ownParts(page)
    const building = before >= 0 && parts > before
    if (building) grew = Date.now()
    if (thin && (parts < 0 || Date.now() - grew >= QUIET_MS || Date.now() >= last)) return result
    if (!thin && Date.now() >= (building ? last : deadline)) {
      throw new Error('The page has not exposed readable content after waiting. Use look to inspect the rendered page and verify its address. Do not infer that it is empty, that login is required, or that the requested information is absent.')
    }
    await page.waitForTimeout(Math.min(thin ? QUIET_MS / 3 : wait, Math.max(0, (building || thin ? last : deadline) - Date.now())))
    wait = Math.min(wait * 2, 1_600)
  }
}
