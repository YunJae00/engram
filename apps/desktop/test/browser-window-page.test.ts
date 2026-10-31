import { EventEmitter } from 'node:events'
import type { BrowserContext } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowPage } from '../src/main/browser-window-page.js'

function fixture(announce = true) {
  const existing = { isClosed: () => false }
  const wanted = { isClosed: () => false, id: 'allocated' }
  const popup = { isClosed: () => false, id: 'unrelated' }
  const detach = vi.fn(async () => undefined)
  const send = vi.fn(async (method: string) => {
    if (method === 'Target.createTarget') {
      context.emit('page', popup)
      if (announce) context.emit('page', wanted)
      return { targetId: 'allocated' }
    }
    return { success: true }
  })
  const context = Object.assign(new EventEmitter(), {
    pages: () => [existing],
    newCDPSession: async (page: typeof existing | typeof wanted) => page === existing ? { send, detach } : {
      send: async () => ({ targetInfo: { targetId: (page as typeof wanted).id } }), detach,
    },
  })
  return { context, wanted, send, detach, typed: context as unknown as BrowserContext }
}

afterEach(() => vi.useRealTimers())

describe('independent browser windows', () => {
  it('matches the allocated target even when another popup arrives first', async () => {
    const { typed, context, wanted, send } = fixture()
    expect(await createWindowPage(typed, { width: 1280, height: 860 })).toBe(wanted)
    expect(send).toHaveBeenCalledWith('Target.createTarget', expect.objectContaining({
      newWindow: true, focus: false, left: -4000, top: -4000, width: 1280, height: 860,
    }))
    expect(context.listenerCount('page')).toBe(0)
    expect(context.listenerCount('close')).toBe(0)
  })

  it('closes only its own target when the new page never arrives', async () => {
    vi.useFakeTimers()
    const { typed, context, send } = fixture(false)
    const opening = createWindowPage(typed, { width: 1280, height: 860 })
    const failed = expect(opening).rejects.toThrow('did not become ready')
    await vi.advanceTimersByTimeAsync(15000)
    await failed
    expect(send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'allocated' })
    expect(context.listenerCount('page')).toBe(0)
  })
})
