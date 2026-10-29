import type { Page } from 'playwright-core'

// Browser event registrations include handlers that have no HTML onclick attribute.
export async function readClickListeners(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page).catch(() => null)
  if (!session) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([ (async () => {
      await Promise.all(page.frames().map(frame => frame.evaluate(() => { (globalThis as typeof globalThis & { __engramClickListeners?: WeakSet<Element> }).__engramClickListeners = new WeakSet() }).catch(() => undefined)))
      const { result } = await session.send('Runtime.evaluate', { expression: 'document', objectGroup: 'engram-listeners' })
      if (!result.objectId) return
      const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: -1, pierce: true })
      const nodes = [...new Set(listeners.filter(listener => ['click', 'dblclick', 'mousedown', 'pointerdown'].includes(listener.type)).map(listener => listener.backendNodeId).filter((id): id is number => id !== undefined))]
      // Resolve in small batches so a large application cannot flood CDP.
      for (let at = 0; at < nodes.length; at += 16) await Promise.all(nodes.slice(at, at + 16).map(async backendNodeId => {
        const { object } = await session.send('DOM.resolveNode', { backendNodeId, objectGroup: 'engram-listeners' })
        if (object.objectId) await session.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: 'function() { const w = this.ownerDocument?.defaultView; if (w) (w.__engramClickListeners ??= new WeakSet()).add(this); }',
        })
      }))
    })(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) }) ])
  } catch { /* The normal DOM reader still works on browsers without this CDP domain. */ }
  finally {
    clearTimeout(timer)
    await session.send('Runtime.releaseObjectGroup', { objectGroup: 'engram-listeners' }).catch(() => undefined)
    await session.detach().catch(() => undefined)
  }
}
