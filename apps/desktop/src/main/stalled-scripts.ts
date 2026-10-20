import type { BrowserContext, CDPSession, Page, Request } from 'playwright-core'
import { flog } from './flog.js'

// A script from another site that does not answer holds the page it is on:
// the page stops parsing until it gives up, ten seconds and more on some
// networks. A host whose script once went that long without a first byte is
// blocked by its exact address within this browser context, retaining cache
// without blocking other resources or the host's own pages.
const STALL_MS = 4_000
const STALLED_CAP = 128

const hostOf = (url: string): string => { try { return new URL(url).hostname } catch { return '' } }
const siteOf = (host: string): string => host.split('.').slice(-2).join('.')

export function foreignHost(url: string, pageUrl: string): string | null {
  const host = hostOf(url), page = hostOf(pageUrl)
  return host && page && siteOf(host) !== siteOf(page) ? host : null
}

export function stalledAfter(waitedMs: number, firstByteMs: number): boolean {
  return (firstByteMs >= 0 ? firstByteMs : waitedMs) >= STALL_MS
}

async function block(context: BrowserContext, sessions: WeakMap<Page, Promise<CDPSession>>, stalled: Set<string>, page: Page): Promise<void> {
  if (!stalled.size || page.isClosed()) return
  let session = sessions.get(page)
  if (!session) {
    session = context.newCDPSession(page).then(async (opened) => { await opened.send('Network.enable'); return opened })
    sessions.set(page, session)
  }
  await (await session).send('Network.setBlockedURLs', { urls: [...stalled].filter(url => foreignHost(url, page.url())) })
}

export function watchStalledScripts(context: BrowserContext): void {
  const stalled = new Set<string>()
  const started = new WeakMap<Request, { at: number; url: string; foreign: boolean }>()
  const sessions = new WeakMap<Page, Promise<CDPSession>>()
  const blockAll = () => { for (const page of context.pages()) void block(context, sessions, stalled, page).catch(() => undefined) }
  context.on('request', (request) => {
    if (request.resourceType() !== 'script') return
    let pageUrl = ''
    try { pageUrl = request.frame().url() } catch { /* A worker's request has no frame. */ }
    const url = request.url()
    if (!/^https?:\/\//.test(url) || url.includes('*')) return
    started.set(request, { at: Date.now(), url, foreign: !!foreignHost(url, pageUrl) })
  })
  const settle = (request: Request) => {
    const start = started.get(request)
    if (!start?.foreign || stalled.has(start.url) || stalled.size >= STALLED_CAP) return
    if (!stalledAfter(Date.now() - start.at, request.timing().responseStart)) return
    stalled.add(start.url)
    flog('browser', `blocking a stalled script from ${hostOf(start.url)} after ${Math.round((Date.now() - start.at) / 1000)}s`)
    blockAll()
  }
  context.on('requestfinished', settle)
  context.on('requestfailed', settle)
  const watchPage = (page: Page) => {
    const refresh = () => void block(context, sessions, stalled, page).catch(() => undefined)
    page.on('framenavigated', refresh)
    refresh()
  }
  context.on('page', watchPage)
  for (const page of context.pages()) watchPage(page)
  blockAll()
}
