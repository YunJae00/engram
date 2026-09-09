import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  canvas: { width: 0, height: 0, dataset: {} as Record<string, string>, getContext: vi.fn() },
  effects: [] as Array<() => (() => void) | undefined>,
}))
vi.mock('react', () => ({ useRef: () => ({ current: state.canvas }), useEffect: (effect: () => (() => void) | undefined) => state.effects.push(effect) }))
vi.mock('../src/renderer/src/lib/agentMirrorLive.js', () => ({ agentMirror: {} }))
import { FrameScreen } from '../src/renderer/src/components/FrameScreen.js'

afterEach(() => { vi.unstubAllGlobals(); state.effects.length = 0 })

it('decodes frames natively, coalesces a burst and ignores completion after unmount', async () => {
  const decoded: Array<{ src: string; finish(): void }> = []
  const drawImage = vi.fn()
  state.canvas.getContext.mockReturnValue({ clearRect: vi.fn(), drawImage })
  vi.stubGlobal('atob', vi.fn(() => { throw new Error('Per-byte frame conversion is not needed') }))
  vi.stubGlobal('Image', class {
    src = ''
    decoding = ''
    naturalWidth = 2560
    naturalHeight = 1720
    decode() { return new Promise<void>((resolve) => decoded.push({ src: this.src, finish: resolve })) }
  })
  let receive: ((data: string) => void) | undefined
  const off = vi.fn()
  FrameScreen({ source: (paint) => { receive = paint; return off } })
  const unmount = state.effects[0]!()
  receive!('first')
  receive!('discarded')
  receive!('latest')
  expect(decoded).toHaveLength(1)
  decoded[0]!.finish()
  await vi.waitFor(() => expect(decoded).toHaveLength(2))
  expect(decoded[1]!.src).toBe('data:image/jpeg;base64,latest')
  expect(state.canvas.width).toBe(2560)
  expect(state.canvas.height).toBe(1720)
  expect(drawImage).toHaveBeenCalledTimes(1)
  unmount!()
  decoded[1]!.finish()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(drawImage).toHaveBeenCalledTimes(1)
  expect(off).toHaveBeenCalledOnce()
  expect(atob).not.toHaveBeenCalled()
})
