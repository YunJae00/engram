import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({
  binding: { lane: 'bot-one', source: 'window:42:0', name: 'Fixture', window: '42', pid: 55, readable: true, revision: 0, host: { request: vi.fn() } },
  lookup: vi.fn(), read: vi.fn(), act: vi.fn(), bitmap: vi.fn(), image: vi.fn(), decode: vi.fn(), ensure: vi.fn(), windows: vi.fn(), available: true,
}))
vi.mock('electron', () => ({ nativeImage: { createFromBitmap: fake.image, createFromBuffer: fake.decode } }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopBinding: fake.lookup, desktopWindows: fake.windows }))
vi.mock('../src/main/desktop-control.js', () => ({ readControlledDesktop: fake.read, actOnDesktop: fake.act, ensureDesktopControl: fake.ensure, withDesktopActivity: (_lane: string, run: () => Promise<unknown>) => run() }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: { available: () => fake.available } }))
import { desktopAgentTools, desktopContext } from '../src/main/desktop-agent.js'

const observation = (snapshot = 'fresh'): DesktopObservationDto => ({
  snapshot, truncated: false, nodes: [], bounds: { x: -10, y: 20, width: 40, height: 40 },
  captureBounds: { x: -8, y: 24, width: 32, height: 32 }, protectedBounds: [{ x: 8, y: 40, width: 1, height: 1 }],
})
const captured = () => ({ basis: 'client-physical', bounds: observation().captureBounds, width: 32, height: 32, data: Buffer.from('encoded-image').toString('base64') })
function look(signal?: AbortSignal) {
  return desktopAgentTools('bot-one').find((item) => item.name === 'look_desktop')!.runRich!({}, { task: 'Inspect the fixture', ...(signal ? { signal } : {}) })
}
beforeEach(() => {
  vi.clearAllMocks()
  fake.binding = { lane: 'bot-one', source: 'window:42:0', name: 'Fixture', window: '42', pid: 55, readable: true, revision: 0, host: { request: vi.fn().mockResolvedValue(captured()) } }
  fake.lookup.mockImplementation(() => fake.binding)
  fake.available = true
  fake.ensure.mockImplementation(async () => fake.binding)
  fake.windows.mockResolvedValue([{ id: 'window:42:0', name: 'Fixture', foreground: true }, { id: 'window:43:0', name: 'Notes' }])
  fake.read.mockResolvedValue(observation())
  fake.bitmap.mockImplementation(() => Buffer.alloc(32 * 32 * 4, 255))
  fake.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }), toBitmap: fake.bitmap })
  fake.image.mockReturnValue({ toJPEG: () => Buffer.from('fixture-image') })
})
describe('desktop image consent and capture validation', () => {
  it('offers the computer whenever this build can drive it, and never without the helper', async () => {
    fake.available = false
    expect(desktopAgentTools('bot-one')).toEqual([])
    expect(desktopContext()).toBe('')
    fake.available = true
    const tools = desktopAgentTools('bot-one')
    expect(tools.map((tool) => tool.name)).toEqual(['list_apps', 'open_app', 'list_windows', 'read_desktop', 'look_desktop', 'desktop_action', 'desktop_sequence'])
    expect(desktopContext()).toContain('that is what takes control')
    expect(await tools.find((tool) => tool.name === 'list_windows')!.run({}, { task: 'Inspect the fixture' })).toBe('- Fixture (in front)' + String.fromCharCode(10) + '- Notes')
    expect(fake.binding.host.request).not.toHaveBeenCalled()
  })
  it('a look names the app to bring forward and takes control before capturing', async () => {
    fake.read.mockResolvedValueOnce(observation('before')).mockResolvedValueOnce(observation('after'))
    await desktopAgentTools('bot-one').find((item) => item.name === 'look_desktop')!.runRich!({ app: 'Fixture' }, { task: 'Inspect the fixture' })
    expect(fake.ensure).toHaveBeenCalledWith('bot-one', { app: 'Fixture' })
    expect(fake.read).toHaveBeenCalledWith('bot-one', undefined, true)
  })
  it('masks using client coordinates and returns the latest snapshot', async () => {
    fake.read.mockResolvedValueOnce(observation('before')).mockResolvedValueOnce(observation('after'))
    const result = await look()
    expect(fake.binding.host.request).toHaveBeenCalledWith('capture', { window: '42', pid: 55, snapshot: 'before' })
    expect(fake.read).toHaveBeenCalledTimes(2)
    expect(result.text).toContain('"snapshot":"after"')
    expect(result.image?.mimeType).toBe('image/jpeg')
    const pixels = fake.image.mock.calls[0]![0] as Buffer
    const offset = (16 * 32 + 16) * 4
    expect([...pixels.subarray(offset, offset + 4)]).toEqual([32, 32, 32, 255])
    expect([...pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255])
  })
  it.each([true, undefined, 'false', 0])('does not capture with incomplete coverage (%s)', async (truncated) => {
    fake.read.mockResolvedValueOnce({ ...observation(), truncated })
    await expect(look()).rejects.toThrow('Use read_desktop')
    expect(fake.binding.host.request).not.toHaveBeenCalled()
  })
  it.each([true, undefined, 'false', 0])('discards pixels after incomplete follow-up (%s)', async (truncated) => {
    fake.read.mockResolvedValueOnce(observation()).mockResolvedValueOnce({ ...observation(), truncated })
    await expect(look()).rejects.toThrow('accessibility scan was incomplete')
    expect(fake.decode).not.toHaveBeenCalled()
  })
  it.each(['bounds', 'captureBounds', 'protectedBounds'] as const)('rejects changed %s', async (field) => {
    const after = observation()
    if (field === 'protectedBounds') after.protectedBounds![0]!.x++
    else after[field]!.x++
    fake.read.mockResolvedValueOnce(observation()).mockResolvedValueOnce(after)
    await expect(look()).rejects.toThrow('window changed')
    expect(fake.image).not.toHaveBeenCalled()
  })
  it.each(['missing', 'invalid', 'protected'] as const)('rejects %s geometry before capture', async (kind) => {
    const invalid = observation()
    if (kind === 'missing') delete invalid.captureBounds
    else if (kind === 'invalid') invalid.captureBounds!.width = Number.NaN
    else invalid.protectedBounds![0]!.height = 0
    fake.read.mockResolvedValueOnce(invalid)
    await expect(look()).rejects.toThrow('safe screenshot geometry')
    expect(fake.binding.host.request).not.toHaveBeenCalled()
  })
  it('discards an image after identity validation fails', async () => {
    fake.read.mockResolvedValueOnce(observation()).mockRejectedValueOnce(new Error('Window replaced'))
    await expect(look()).rejects.toThrow('replaced')
    expect(fake.image).not.toHaveBeenCalled()
  })
  it.each(['permission', 'replacement', 'abort'] as const)('discards delayed capture after %s', async (change) => {
    let resolve!: (value: unknown) => void
    fake.binding.host.request.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const controller = new AbortController()
    const pending = expect(look(controller.signal)).rejects.toThrow()
    await vi.waitFor(() => expect(fake.binding.host.request).toHaveBeenCalled())
    if (change === 'permission') fake.binding.readable = false
    else if (change === 'replacement') fake.binding = { ...fake.binding, revision: 1 }
    else controller.abort()
    resolve(captured())
    await pending
    expect(fake.image).not.toHaveBeenCalled()
  })
  it.each(['basis', 'bounds', 'data'] as const)('rejects unverified native %s', async (field) => {
    const value = captured()
    if (field === 'basis') value.basis = 'outer-window'
    else if (field === 'bounds') value.bounds = observation().bounds
    else value.data = '?'
    fake.binding.host.request.mockResolvedValueOnce(value)
    await expect(look()).rejects.toThrow('verified screenshot geometry')
    expect(fake.decode).not.toHaveBeenCalled()
  })
  it('rejects an invalid bitmap size', async () => {
    fake.bitmap.mockReturnValueOnce(Buffer.alloc(1))
    await expect(look()).rejects.toThrow('invalid screenshot')
    expect(fake.image).not.toHaveBeenCalled()
  })
})
