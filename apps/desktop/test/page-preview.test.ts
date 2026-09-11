import { EventEmitter } from 'node:events'
import type { Page } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureSharpFrame, startPagePreview } from '../src/main/page-preview.js'

function fixture() {
  const cdp = Object.assign(new EventEmitter(), { send: vi.fn(async () => ({ data: 'lossless' })), detach: vi.fn(async () => undefined) })
  const page = Object.assign(new EventEmitter(), { context: () => ({ newCDPSession: async () => cdp }), viewportSize: () => ({ width: 1280, height: 860 }) })
  return { cdp, page: page as unknown as Page }
}

afterEach(() => vi.useRealTimers())
describe('compositor previews', () => {
  it('renders the full high-resolution clip instead of clipping it to the unscaled surface', async () => {
    const { page, cdp } = fixture()
    const png = Buffer.alloc(24)
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png)
    png.writeUInt32BE(1280, 16)
    cdp.send.mockResolvedValue({ data: png.toString('base64') })
    await captureSharpFrame(page, cdp)
    expect(cdp.send).toHaveBeenLastCalledWith('Page.captureScreenshot', expect.objectContaining({
      captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1280, height: 860, scale: 2 },
    }))
  })
  it('shares a sharp capture between consumers with separate CDP sessions', async () => {
    const { page, cdp } = fixture()
    const other = fixture().cdp
    const [first, second] = await Promise.all([captureSharpFrame(page, cdp), captureSharpFrame(page, other)])
    expect(first).toEqual(second)
    expect(other.send).not.toHaveBeenCalled()
    expect(cdp.send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot')).toHaveLength(1)
  })

  it('refreshes a settled navigation frame when the deferred document becomes ready', async () => {
    vi.useFakeTimers()
    const { page, cdp } = fixture()
    cdp.send.mockResolvedValue({ data: 'before-content' })
    const receive = vi.fn()
    const stop = await startPagePreview(page, receive)
    await vi.advanceTimersByTimeAsync(61)
    expect(receive.mock.calls.at(-1)?.[0].data).toBe('before-content')
    cdp.send.mockResolvedValue({ data: 'document-content' })
    page.emit('domcontentloaded')
    await vi.advanceTimersByTimeAsync(500)
    expect(receive.mock.calls.at(-1)?.[0].data).toBe('document-content')
    stop()
    await vi.advanceTimersByTimeAsync(200)
    expect(page.listenerCount('domcontentloaded')).toBe(0)
  })

  it('delivers lossless stills, limits motion frames, and stops encoding when hidden', async () => {
    vi.useFakeTimers()
    const { page, cdp } = fixture()
    const receive = vi.fn()
    const stop = await startPagePreview(page, receive)
    await vi.advanceTimersByTimeAsync(61)
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
    expect(receive).toHaveBeenCalledTimes(3)
    expect(receive.mock.calls[1]?.[0].data).toBe('second')
    await vi.advanceTimersByTimeAsync(500)
    expect(receive.mock.calls.at(-1)?.[0].data).toBe('lossless')
    const captures = cdp.send.mock.calls.filter((args) => args[0] === 'Page.captureScreenshot').length
    await vi.advanceTimersByTimeAsync(1000)
    expect(cdp.send.mock.calls.filter((args) => args[0] === 'Page.captureScreenshot')).toHaveLength(captures)
    stop()
    await vi.advanceTimersByTimeAsync(200)
    expect(cdp.detach).toHaveBeenCalledOnce()
    expect(page.listenerCount('framenavigated')).toBe(0)
  })

  it('keeps the sharp still when capture emits a temporary surface and then restores it', async () => {
    vi.useFakeTimers()
    const { page, cdp } = fixture()
    const receive = vi.fn()
    const stop = await startPagePreview(page, receive)
    await vi.advanceTimersByTimeAsync(61)
    const frame = (data: string) => cdp.emit('Page.screencastFrame', { data, sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 860 } })
    frame('stable')
    await vi.advanceTimersByTimeAsync(390)
    expect(receive.mock.calls.at(-1)?.[0].data).toBe('lossless')
    receive.mockClear()
    frame('temporary capture surface')
    frame('stable')
    await vi.advanceTimersByTimeAsync(61)
    expect(receive).not.toHaveBeenCalled()
    frame('real change')
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ data: 'real change' }))
    stop()
    await vi.advanceTimersByTimeAsync(200)
  })
})
