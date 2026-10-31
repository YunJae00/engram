import type { BrowserContext, Page } from 'playwright-core'

// Separate top-level surfaces keep visible lanes painting independently.
// They still share the same browser context, profile and session cookies.
export async function createWindowPage(context: BrowserContext, size: { width: number; height: number }): Promise<Page> {
  const existing = context.pages().find((page) => !page.isClosed())
  if (!existing) return context.newPage()
  const cdp = await context.newCDPSession(existing)
  const candidates = new Set<Page>()
  let targetId: string | undefined
  let resolvePage!: (page: Page) => void
  let rejectPage!: (error: Error) => void
  const ready = new Promise<Page>((resolve, reject) => { resolvePage = resolve; rejectPage = reject })
  // Attach the rejection handler before either the target or the page arrives.
  void ready.catch(() => undefined)
  const inspect = async (page: Page) => {
    candidates.add(page)
    if (!targetId || page.isClosed()) return
    const session = await context.newCDPSession(page).catch(() => null)
    if (!session) return
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo')
      if (targetInfo.targetId === targetId) resolvePage(page)
    } catch {
      // A popup that closes before inspection cannot be the usable target.
    } finally { await session.detach().catch(() => undefined) }
  }
  const arrived = (page: Page) => { void inspect(page) }
  const closed = () => rejectPage(new Error('browser closed while opening a window'))
  context.on('page', arrived)
  context.once('close', closed)
  const timer = setTimeout(() => rejectPage(new Error('browser window did not become ready')), 15000).unref()
  try {
    const created = await cdp.send('Target.createTarget', {
      url: 'about:blank', newWindow: true, left: -4000, top: -4000,
      ...size, windowState: 'normal', background: false, focus: false,
    })
    targetId = created.targetId
    for (const page of candidates) void inspect(page)
    return await ready
  } catch (error) {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined)
    throw error
  } finally {
    clearTimeout(timer)
    context.off('page', arrived)
    context.off('close', closed)
    await cdp.detach().catch(() => undefined)
  }
}
