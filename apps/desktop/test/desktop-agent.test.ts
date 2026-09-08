import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({
  binding: { lane: 'bot-one', source: 'window:42:0', name: 'Selected fixture', readable: true, revision: 0 },
  lookup: vi.fn(), read: vi.fn(), act: vi.fn(), sources: vi.fn(), bitmap: vi.fn(), image: vi.fn(),
}))
vi.mock('electron', () => ({ desktopCapturer: { getSources: fake.sources }, nativeImage: { createFromBitmap: fake.image } }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopBinding: fake.lookup }))
vi.mock('../src/main/desktop-control.js', () => ({ readControlledDesktop: fake.read, actOnDesktop: fake.act }))
import { desktopAgentTools, desktopContext } from '../src/main/desktop-agent.js'

const observation = (snapshot = 'fresh'): DesktopObservationDto & { truncated: boolean } => ({
  snapshot, truncated: false, nodes: [], bounds: { x: -10, y: 20, width: 4, height: 4 },
  protectedBounds: [{ x: -9, y: 21, width: 1, height: 1 }],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function look(signal?: AbortSignal) {
  const tool = desktopAgentTools('bot-one').find((item) => item.name === 'look_desktop')!
  return tool.runRich!({}, { task: 'Inspect the selected fixture', ...(signal ? { signal } : {}) })
}

beforeEach(() => {
  vi.clearAllMocks()
  fake.binding = { lane: 'bot-one', source: 'window:42:0', name: 'Selected fixture', readable: true, revision: 0 }
  fake.lookup.mockImplementation(() => fake.binding)
  fake.read.mockResolvedValue(observation())
  fake.bitmap.mockImplementation(() => Buffer.alloc(4 * 4 * 4, 255))
  fake.sources.mockResolvedValue([{ id: 'window:42:0', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 4, height: 4 }), toBitmap: fake.bitmap } }])
  fake.image.mockReturnValue({ toJPEG: () => Buffer.from('fixture-image') })
})

describe('desktop image consent and capture validation', () => {
  it('exposes no tools or context without read permission', () => {
    fake.binding.readable = false
    expect(desktopAgentTools('bot-one')).toEqual([])
    expect(desktopContext('bot-one')).toBe('')
    expect(fake.sources).not.toHaveBeenCalled()
  })

  it('revalidates after capture, masks protected pixels and returns the latest snapshot', async () => {
    fake.read.mockResolvedValueOnce(observation('before')).mockResolvedValueOnce(observation('after'))
    const result = await look()
    expect(fake.read).toHaveBeenCalledTimes(2)
    expect(fake.read).toHaveBeenLastCalledWith('bot-one', undefined, true)
    expect(result.text).toContain('"snapshot":"after"')
    expect(result.image?.mimeType).toBe('image/jpeg')
    const pixels = fake.image.mock.calls[0]![0] as Buffer
    expect([...pixels.subarray(20, 24)]).toEqual([32, 32, 32, 255])
    expect([...pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255])
  })

  it.each([true, undefined, 'false', 0])('does not capture without explicit complete accessibility coverage (%s)', async (truncated) => {
    fake.read.mockResolvedValueOnce({ ...observation(), truncated, protectedBounds: [] })
    await expect(look()).rejects.toThrow('Use read_desktop for available text, or choose a simpler window')
    expect(fake.sources).not.toHaveBeenCalled()
    expect(fake.bitmap).not.toHaveBeenCalled()
    expect(fake.image).not.toHaveBeenCalled()
  })

  it.each([true, undefined, 'false', 0])('discards captured pixels if the follow-up scan is incomplete (%s)', async (truncated) => {
    fake.read.mockResolvedValueOnce(observation()).mockResolvedValueOnce({ ...observation(), truncated })
    await expect(look()).rejects.toThrow('accessibility scan was incomplete')
    expect(fake.sources).toHaveBeenCalledTimes(1)
    expect(fake.bitmap).not.toHaveBeenCalled()
    expect(fake.image).not.toHaveBeenCalled()
  })

  it.each(['bounds', 'protectedBounds'] as const)('rejects changed %s between observation and capture', async (field) => {
    const after = observation()
    if (field === 'bounds') after.bounds.x++
    else after.protectedBounds![0]!.x++
    fake.read.mockResolvedValueOnce(observation()).mockResolvedValueOnce(after)
    await expect(look()).rejects.toThrow('window changed')
    expect(fake.image).not.toHaveBeenCalled()
  })

  it('rejects malformed masking geometry instead of returning unmasked pixels', async () => {
    const invalid = observation()
    invalid.protectedBounds![0]!.width = Number.NaN
    fake.read.mockResolvedValueOnce(invalid)
    await expect(look()).rejects.toThrow('safe screenshot geometry')
    expect(fake.sources).not.toHaveBeenCalled()
  })

  it('does not return pixels after native identity validation fails', async () => {
    fake.read.mockResolvedValueOnce(observation()).mockRejectedValueOnce(new Error('The window was replaced'))
    await expect(look()).rejects.toThrow('replaced')
    expect(fake.image).not.toHaveBeenCalled()
  })

  it.each(['permission', 'replacement', 'abort'] as const)('discards delayed capture after %s changes', async (change) => {
    const capture = deferred<unknown[]>()
    fake.sources.mockReturnValueOnce(capture.promise)
    const controller = new AbortController()
    const result = look(controller.signal)
    const rejected = expect(result).rejects.toThrow()
    await vi.waitFor(() => expect(fake.sources).toHaveBeenCalled())
    if (change === 'permission') fake.binding.readable = false
    else if (change === 'replacement') fake.binding = { ...fake.binding, revision: 1 }
    else controller.abort()
    capture.resolve([])
    await rejected
    expect(fake.image).not.toHaveBeenCalled()
  })

  it('never uses another window thumbnail as a fallback', async () => {
    fake.sources.mockResolvedValueOnce([{ id: 'window:99:0', thumbnail: {} }])
    await expect(look()).rejects.toThrow('did not provide a screenshot')
    expect(fake.image).not.toHaveBeenCalled()
  })

  it('rejects an invalid bitmap size', async () => {
    fake.bitmap.mockReturnValueOnce(Buffer.alloc(1))
    await expect(look()).rejects.toThrow('invalid screenshot')
    expect(fake.image).not.toHaveBeenCalled()
  })
})
