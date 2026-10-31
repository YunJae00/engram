import { EventEmitter } from 'node:events'
import type { Page } from 'playwright-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureSharpFrame, resizePreview, startPagePreview, withPreviewInput } from '../src/main/page-preview.js'
const scaled = vi.hoisted(() => ({ value: undefined as number | undefined }))
vi.mock('../src/main/browser-macos.js', () => ({ macBrowserScale: () => scaled.value }))

function fixture() {
  const cdp = Object.assign(new EventEmitter(), { send: vi.fn(async () => ({ data: Buffer.from('lossless').toString('base64') })), detach: vi.fn(async () => undefined) })
  const shot = vi.fn(async () => Buffer.from('lossless'))
  const page = Object.assign(new EventEmitter(), { screenshot: shot }, { context: () => ({ newCDPSession: async () => cdp }), viewportSize: () => ({ width: 1280, height: 860 }) })
  return { cdp, shot, page: page as unknown as Page }
}

afterEach(() => { vi.useRealTimers(); scaled.value = undefined })
describe('compositor previews', () => {
  it('captures CDP-attached pages at the requested resolution without changing their viewport', async () => {
    scaled.value = 2
    const { page, cdp, shot } = fixture()
    await expect(captureSharpFrame(page)).resolves.toMatchObject({ width: 1280, height: 860 })
    expect(shot).not.toHaveBeenCalled()
    expect(cdp.send).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1280, height: 860, scale: 2 } })
    expect(cdp.detach).toHaveBeenCalledOnce()
  })

  it('bounds CDP capture and detaches its session when the compositor stalls', async () => {
    vi.useFakeTimers(); scaled.value = 2
    const { page, cdp } = fixture()
    cdp.send.mockImplementation(() => new Promise(() => {}))
    const failed = expect(captureSharpFrame(page)).rejects.toThrow('capture timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await failed
    expect(cdp.detach).toHaveBeenCalledOnce()
  })
  it('holds input until capture restores the compositor without blocking other pages', async () => {
    vi.useFakeTimers()
    const { page, shot } = fixture()
    let finish!: () => void
    shot.mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve }); return Buffer.from('frame') })
    const frame = captureSharpFrame(page)
    await vi.advanceTimersByTimeAsync(1)
    const input = vi.fn(async () => undefined)
    const dispatched = withPreviewInput(page, input)
    await withPreviewInput(fixture().page, async () => undefined)
    expect(input).not.toHaveBeenCalled()
    finish()
    await frame
    await vi.advanceTimersByTimeAsync(59)
    expect(input).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await dispatched
    expect(input).toHaveBeenCalledOnce()
  })
  it('orders viewport updates after capture restoration without blocking other pages', async () => {
    const { page, shot } = fixture()
    let finish!: () => void
    shot.mockImplementation(async () => { await new Promise<void>((resolve) => { finish = resolve }); return Buffer.from('frame') })
    const resize = vi.fn(async () => undefined)
    page.setViewportSize = resize
    const frame = captureSharpFrame(page)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const changed = resizePreview(page, { width: 720, height: 600 })
    expect(resize).not.toHaveBeenCalled()
    const other = fixture()
    await expect(captureSharpFrame(other.page)).resolves.toMatchObject({ data: Buffer.from('lossless').toString('base64') })
    finish()
    await frame
    expect(await changed).toBe(true)
    expect(resize).toHaveBeenCalledExactlyOnceWith({ width: 720, height: 600 })
  })
  it('waits for capture restoration before resizing the same page', async () => {
    vi.useFakeTimers()
    const { page } = fixture()
    page.setViewportSize = vi.fn(async () => undefined)
    await captureSharpFrame(page)
    const changed = resizePreview(page, { width: 720, height: 600 })
    await vi.advanceTimersByTimeAsync(59)
    expect(page.setViewportSize).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await changed).toBe(true)
    expect(page.setViewportSize).toHaveBeenCalledExactlyOnceWith({ width: 720, height: 600 })
  })
  it('waits for the real resize before measuring and capturing the next frame', async () => {
    const { page, shot } = fixture()
    let finish!: () => void
    page.setViewportSize = async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      vi.spyOn(page, 'viewportSize').mockReturnValue({ width: 720, height: 600 })
    }
    const changed = resizePreview(page, { width: 720, height: 600 })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const frame = captureSharpFrame(page)
    expect(shot).not.toHaveBeenCalled()
    finish()
    await changed
    expect(await frame).toMatchObject({ width: 720, height: 600 })
    expect(await resizePreview(page, { width: 720, height: 600 })).toBe(false)
  })
  it('refreshes a settled shared stream when the pane resizes without a compositor event', async () => {
    vi.useFakeTimers()
    const { page, cdp, shot } = fixture()
    const receive = vi.fn()
    const stop = await startPagePreview(page, receive)
    await vi.advanceTimersByTimeAsync(500)
    vi.spyOn(page, 'viewportSize').mockReturnValue({ width: 360, height: 296 })
    shot.mockResolvedValue(Buffer.from('resized'))
    await vi.advanceTimersByTimeAsync(1200)
    expect(receive).toHaveBeenLastCalledWith({ data: Buffer.from('resized').toString('base64'), width: 360, height: 296 })
    expect(cdp.send).toHaveBeenCalledWith('Page.stopScreencast')
    stop()
    await vi.advanceTimersByTimeAsync(200)
  })
  it('rejects a capture measured against a viewport that changed while capturing', async () => {
    const { page, shot } = fixture()
    shot.mockImplementation(async () => {
      vi.spyOn(page, 'viewportSize').mockReturnValue({ width: 360, height: 296 })
      return Buffer.from('stale')
    })
    await expect(captureSharpFrame(page)).rejects.toThrow('viewport changed')
  })
  it('captures at device resolution through the owning page without resetting another session’s emulation', async () => {
    const { page, cdp, shot } = fixture()
    await captureSharpFrame(page)
    expect(shot).toHaveBeenCalledExactlyOnceWith({ type: 'png', scale: 'device', caret: 'initial', timeout: 5000 })
    expect(cdp.send).not.toHaveBeenCalled()
  })
  it('shares a sharp capture between consumers', async () => {
    const { page, shot } = fixture()
    const [first, second] = await Promise.all([captureSharpFrame(page), captureSharpFrame(page)])
    expect(first).toEqual(second)
    expect(shot).toHaveBeenCalledOnce()
  })

  it('refreshes a settled navigation frame when the deferred document becomes ready', async () => {
    vi.useFakeTimers()
    const { page, shot } = fixture()
    shot.mockResolvedValue(Buffer.from('before-content'))
    const receive = vi.fn()
    const stop = await startPagePreview(page, receive)
    await vi.advanceTimersByTimeAsync(61)
    expect(receive.mock.calls.at(-1)?.[0].data).toBe(Buffer.from('before-content').toString('base64'))
    shot.mockResolvedValue(Buffer.from('document-content'))
    page.emit('domcontentloaded')
    await vi.advanceTimersByTimeAsync(500)
    expect(receive.mock.calls.at(-1)?.[0].data).toBe(Buffer.from('document-content').toString('base64'))
    stop()
    await vi.advanceTimersByTimeAsync(200)
    expect(page.listenerCount('domcontentloaded')).toBe(0)
  })

  it('delivers lossless stills, limits motion frames, and stops encoding when hidden', async () => {
    vi.useFakeTimers()
    const { page, cdp, shot } = fixture()
    const receive = vi.fn()
    const stop = await startPagePreview(page, receive)
    await vi.advanceTimersByTimeAsync(61)
    expect(shot).toHaveBeenCalledWith(expect.objectContaining({ type: 'png' }))
    expect(receive).toHaveBeenCalledWith({ data: Buffer.from('lossless').toString('base64'), width: 1280, height: 860 })
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
    await vi.advanceTimersByTimeAsync(26)
    expect(receive).toHaveBeenCalledTimes(3)
    expect(receive.mock.calls[1]?.[0].data).toBe('second')
    await vi.advanceTimersByTimeAsync(500)
    expect(receive.mock.calls.at(-1)?.[0].data).toBe(Buffer.from('lossless').toString('base64'))
    const captures = shot.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(shot).toHaveBeenCalledTimes(captures)
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
    expect(receive.mock.calls.at(-1)?.[0].data).toBe(Buffer.from('lossless').toString('base64'))
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
