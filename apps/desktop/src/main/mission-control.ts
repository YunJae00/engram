import type { Page } from 'playwright-core'
import { lanePage } from './agent-browser.js'
import type { MissionFrameDto } from '../shared/types.js'

const pending = new Map<Page, Promise<MissionFrameDto>>()

// Monitoring never changes the active lane or the page viewport. A slow
// capture has one owner even when a view is reopened before it finishes.
export async function missionFrames(requested: string[]): Promise<MissionFrameDto[]> {
  const lanes = [...new Set(requested.filter((lane) => typeof lane === 'string' && lane.startsWith('bot-')))].slice(0, 4)
  return Promise.all(lanes.map(async (lane) => {
    const page = lanePage(lane)
    if (!page) return { lane, on: false }
    const held = pending.get(page)
    if (held) return held
    const capture = (async (): Promise<MissionFrameDto> => {
      const cdp = await page.context().newCDPSession(page).catch(() => null)
      if (!cdp) return { lane, on: false }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const viewport = page.viewportSize() ?? { width: 1280, height: 860 }
        // Capture the compositor directly: background tabs need not run
        // layout/font readiness scripts before a monitoring frame arrives.
        const shot = cdp.send('Page.captureScreenshot', {
          format: 'jpeg', quality: 55, fromSurface: true, captureBeyondViewport: false,
          clip: { x: 0, y: 0, ...viewport, scale: 0.5 },
        })
        const { data } = await Promise.race([
          shot,
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('preview capture timed out')), 5000) }),
        ])
        if (lanePage(lane) !== page) return { lane, on: false }
        return { lane, on: true, url: page.url(), data, at: Date.now() }
      } catch {
        return { lane, on: !page.isClosed(), url: page.isClosed() ? undefined : page.url() }
      } finally {
        clearTimeout(timer)
        await cdp.detach().catch(() => undefined)
      }
    })()
    pending.set(page, capture)
    try { return await capture } finally { pending.delete(page) }
  }))
}
