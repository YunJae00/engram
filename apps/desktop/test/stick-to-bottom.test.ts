import { afterEach, expect, it, vi } from 'vitest'
const held = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('react', () => ({ useRef: () => held, useLayoutEffect: (effect: () => void) => effect(), useEffect: () => undefined }))
import { useStickToBottom } from '../src/renderer/src/lib/useStickToBottom.js'
afterEach(() => { held.current = undefined; vi.unstubAllGlobals() })

it('returns to a new user turn even if its reply already ended, while preserving readers on other updates', () => {
  const events = new Map<string, () => void>()
  let paint: ((now: number) => void) | undefined
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.stubGlobal('requestAnimationFrame', (callback: (now: number) => void) => { paint = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => { paint = undefined })
  vi.stubGlobal('ResizeObserver', class { observe = vi.fn(); disconnect = vi.fn() })
  vi.stubGlobal('MutationObserver', class { observe = vi.fn(); disconnect = vi.fn() })
  const list = {
    scrollTop: 0, scrollHeight: 1000, clientHeight: 100, children: [],
    addEventListener: (event: string, callback: () => void) => events.set(event, callback), removeEventListener: vi.fn(),
  }
  const ref = { current: list as unknown as HTMLElement }
  const previous = [{ role: 'user' }, { role: 'assistant', streaming: false }]
  useStickToBottom(ref, previous, 'one')
  expect(list.scrollTop).toBe(900)
  list.scrollTop = 100; events.get('scroll')!()
  useStickToBottom(ref, [...previous, { role: 'assistant', streaming: false }], 'one')
  expect(list.scrollTop).toBe(100)
  expect(paint).toBeUndefined()
  useStickToBottom(ref, [...previous, { role: 'user' }, { role: 'assistant', streaming: false }], 'one')
  expect(paint).toBeTypeOf('function')
  paint!(performance.now() + 300)
  expect(list.scrollTop).toBe(900)
})
