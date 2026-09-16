import type { WebPage } from 'core'
import type { Page } from 'playwright-core'

export async function readWhenReady(page: Page, read: () => Promise<WebPage>, signal?: AbortSignal): Promise<WebPage> {
  const deadline = Date.now() + 12_000
  // Each poll is a full multi-frame read; back off so a slow page costs a
  // handful of reads rather than thirty.
  let wait = 400
  while (true) {
    if (signal?.aborted) throw new Error('stopped')
    const result = await read()
    const words = result.text.trim()
    if (result.wall || result.controls?.length || (words && !/^(loading|please wait)[.\s…]*$/i.test(words))) return result
    if (Date.now() >= deadline) {
      throw new Error('The page has not exposed readable content after waiting. Use look to inspect the rendered page and verify its address. Do not infer that it is empty, that login is required, or that the requested information is absent.')
    }
    await page.waitForTimeout(Math.min(wait, Math.max(0, deadline - Date.now())))
    wait = Math.min(wait * 2, 1_600)
  }
}
