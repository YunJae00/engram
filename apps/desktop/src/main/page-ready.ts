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

async function readUntilReady(page: Page, read: (signal?: AbortSignal) => Promise<WebPage>, signal?: AbortSignal): Promise<WebPage> {
  const deadline = Date.now() + 12_000
  // Each poll is a full multi-frame read; back off so a slow page costs a
  // handful of reads rather than thirty.
  let wait = 400
  while (true) {
    if (signal?.aborted) throw new Error('stopped')
    const result = await read(signal)
    if (signal?.aborted) throw new Error('stopped')
    const words = result.text.trim()
    if (result.wall || result.controls?.length || (words && !/^(loading|please wait)[.\s…]*$/i.test(words))) return result
    if (Date.now() >= deadline) {
      throw new Error('The page has not exposed readable content after waiting. Use look to inspect the rendered page and verify its address. Do not infer that it is empty, that login is required, or that the requested information is absent.')
    }
    await page.waitForTimeout(Math.min(wait, Math.max(0, deadline - Date.now())))
    wait = Math.min(wait * 2, 1_600)
  }
}
