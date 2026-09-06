import { EventEmitter } from 'node:events'
import type { Page } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPagePreview } from '../src/main/page-preview.js'

function fixture() {
  const cdp = Object.assign(new EventEmitter(), { send: vi.fn(async () => ({ data: 'lossless' })), detach: vi.fn(async () => undefined) })
  const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: async () => cdp }), viewportSize: () => ({ width: 1280, height: 860 }) })
  return { cdp, page: page as unknown as Page }
}

afterEach(() => vi.useRealTimers())
describe('compositor previews', () => {
  it('delivers lossless stills, limits motion frames, and stops encoding when hidden', async () => {
    vi.useFakeTimers()
    const { page, cdp } = fixture()
    const receive = vi.fn()
    const stop = await startPagePreview(page, receive)
    await vi.advanceTimersByTimeAsync(1)
    expect(cdp.send).toHaveBeenCalledWith('Page.captureScreenshot', expect.objectContaining({ format: 'png' }))
    expect(receive).toHaveBeenCalledWith({ data: 'lossless', width: 1280, height: 860 })
    const frame = (data: string) => cdp.emit('Page.screencastFrame', { data, sessionId: 1, metadata: { deviceWidth: 2560, deviceHeight: 1720 } })
    receive.mockClear()
    frame('first')
    frame('second')
    expect(receive).toHaveBeenCalledTimes(1)
    // The bitmap carries device pixels; the reported size is the page's CSS
    // size, because mirror input is scaled by these numbers.
    expect(receive).toHaveBeenCalledWith({ data: 'first', width: 1280, height: 860 })
    await vi.advanceTimersByTimeAsync(40)
    frame('third')
    expect(receive).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(receive.mock.calls.at(-1)?.[0].data).toBe('lossless')
    const captures = cdp.send.mock.calls.filter((args) => args[0] === 'Page.captureScreenshot').length
    await vi.advanceTimersByTimeAsync(1000)
    expect(cdp.send.mock.calls.filter((args) => args[0] === 'Page.captureScreenshot')).toHaveLength(captures)
    stop()
    await vi.advanceTimersByTimeAsync(1)
    expect(cdp.detach).toHaveBeenCalledOnce()
    expect(page.listenerCount('framenavigated')).toBe(0)
  })
})
