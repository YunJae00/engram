import { afterEach, expect, it, vi } from 'vitest'
import { mountNativeSurface } from '../src/renderer/src/lib/nativeSurfaces.js'

const layout = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../src/renderer/src/api.js', () => ({ api: { nativeLayout: layout } }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('keeps idle layout work at heartbeat rate and coalesces resize events', async () => {
  vi.useFakeTimers()
  let resize!: () => void
  let mutation!: (records: MutationRecord[]) => void
  const listeners = new Map<string, (event: Event) => void>()
  class FakeElement {
    closest() { return this }
    contains() { return false }
  }
  vi.stubGlobal('Element', FakeElement)
  const rect = vi.fn(() => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 }))
  const element = { getBoundingClientRect: rect, parentElement: null, closest: () => null }
  let modal = false
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }))
  vi.stubGlobal('innerWidth', 1000); vi.stubGlobal('innerHeight', 800)
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { body: {}, querySelectorAll: () => modal ? [{ contains: () => false, getBoundingClientRect: rect }] : [], elementFromPoint: () => element, addEventListener: (name: string, callback: (event: Event) => void) => listeners.set(name, callback), removeEventListener: vi.fn() })
  vi.stubGlobal('MutationObserver', class { constructor(callback: (records: MutationRecord[]) => void) { mutation = callback } observe() {} disconnect() {} })
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 16))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  const hidden = vi.fn()
  const unmount = mountNativeSurface(element as unknown as HTMLElement, 'fixture', hidden)
  try {
    await vi.advanceTimersByTimeAsync(5000)
    expect(rect).toHaveBeenCalledTimes(6)
    const before = rect.mock.calls.length
    for (let i = 0; i < 100; i++) { resize(); mutation([]) }
    await vi.advanceTimersByTimeAsync(16)
    expect(rect).toHaveBeenCalledTimes(before + 1)
    expect(layout).toHaveBeenCalled()
    const afterResize = rect.mock.calls.length
    for (let i = 0; i < 100; i++) {
      const target = new FakeElement()
      listeners.get('scroll')!({ target } as unknown as Event)
      mutation([{ target } as unknown as MutationRecord])
    }
    await vi.advanceTimersByTimeAsync(16)
    expect(rect).toHaveBeenCalledTimes(afterResize)
    modal = true; resize(); await vi.advanceTimersByTimeAsync(16)
    expect(hidden).toHaveBeenLastCalledWith(true)
    expect(layout).toHaveBeenLastCalledWith([])
    modal = false; resize(); await vi.advanceTimersByTimeAsync(16)
    expect(hidden).toHaveBeenLastCalledWith(false)
    expect(layout).toHaveBeenLastCalledWith([expect.objectContaining({ lane: 'fixture' })])
  } finally { unmount() }
  expect(vi.getTimerCount()).toBe(0)
})
