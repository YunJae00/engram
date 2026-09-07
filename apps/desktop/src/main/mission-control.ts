import type { Page } from 'playwright-core'
import { lanePage } from './agent-browser.js'
import type { MissionFrameDto } from '../shared/types.js'
import { captureSharpFrame, startPagePreview } from './page-preview.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { isNativePage } from './native-browser.js'

const pending = new Map<Page, Promise<MissionFrameDto>>()

// Monitoring never changes the active lane or the page viewport. A slow
// capture has one owner even when a view is reopened before it finishes.
export async function missionFrames(requested: string[]): Promise<MissionFrameDto[]> {
  const lanes = [...new Set(requested.filter((lane) => typeof lane === 'string' && lane.startsWith('bot-')))].slice(0, 4)
  return Promise.all(lanes.map(async (lane) => {
    const page = lanePage(lane)
    if (!page) return { lane, on: false }
    if (isNativePage(page)) return { lane, on: true, url: page.url() }
    const held = pending.get(page)
    if (held) return held
    const capture = (async (): Promise<MissionFrameDto> => {
      const cdp = await page.context().newCDPSession(page).catch(() => null)
      if (!cdp) return { lane, on: false }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Capture the compositor directly: background tabs need not run
        // layout/font readiness scripts before a monitoring frame arrives.
        const shot = captureSharpFrame(page, cdp)
        const { data } = await Promise.race([
          shot,
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('preview capture timed out')), 5000) }),
        ])
        if (lanePage(lane) !== page) return { lane, on: false }
        return { lane, on: true, url: page.url(), data, at: Date.now() }
      } catch (err) {
        flog('mission-frames', `${lane}: ${err instanceof Error ? err.message : String(err)}`)
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

const streams = new Map<string, { page: Page; stop?: () => void }>()
let watched: string[] = []
let heartbeat: ReturnType<typeof setInterval> | undefined
let expires = 0

function reconcile(): void {
  if (Date.now() > expires) watched = []
  for (const [lane, stream] of streams) {
    if (watched.includes(lane) && lanePage(lane) === stream.page) continue
    stream.stop?.()
    streams.delete(lane)
    broadcast({ type: 'mission:frame', frame: { lane, on: false } })
  }
  for (const lane of watched) {
    const page = lanePage(lane)
    if (!page || streams.has(lane)) continue
    const entry: { page: Page; stop?: () => void } = { page }
    streams.set(lane, entry)
    if (isNativePage(page)) {
      const update = () => broadcast({ type: 'mission:frame', frame: { lane, on: true, url: page.url(), at: Date.now() } })
      page.on('framenavigated', update)
      entry.stop = () => { page.off('framenavigated', update) }
      update()
      continue
    }
    void startPagePreview(page, (frame) => {
      if (streams.get(lane) !== entry) return
      broadcast({ type: 'mission:frame', frame: { lane, on: true, data: frame.data, url: page.url(), at: Date.now() } })
    }).then((stop) => {
      if (streams.get(lane) === entry) entry.stop = stop
      else stop()
    }).catch(() => { if (streams.get(lane) === entry) streams.delete(lane) })
  }
  if (!watched.length) { clearInterval(heartbeat); heartbeat = undefined }
}

// A renewable lease also tears down encoders after a renderer crash/reload.
export function watchMission(lanes: string[]): void {
  watched = [...new Set(lanes.filter((lane) => typeof lane === 'string' && lane.startsWith('bot-')))].slice(0, 4)
  expires = Date.now() + 12000
  reconcile()
  if (watched.length && !heartbeat) heartbeat = setInterval(reconcile, 500).unref()
}
