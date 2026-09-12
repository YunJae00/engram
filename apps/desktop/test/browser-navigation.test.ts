import { beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ pages: new Map(), resize: vi.fn() }))
vi.mock('../src/main/agent-browser.js', () => ({ lanePage: (lane: string) => fake.pages.get(lane), setViewHeight: fake.resize }))
import { browserHistory, browserNavigate, browserResize } from '../src/main/browser-navigation.js'

beforeEach(() => { fake.pages.clear(); vi.clearAllMocks() })
it('navigates only the requested lane and releases the history session even on failure', async () => {
  const session = { send: vi.fn(async () => ({ currentIndex: 1, entries: [{}, {}, {}] })), detach: vi.fn() }
  const page = { isClosed: () => false, context: () => ({ newCDPSession: async () => session }), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn() }
  fake.pages.set('a', page)
  expect(await browserHistory('a')).toEqual({ back: true, forward: true })
  expect(session.detach).toHaveBeenCalledOnce()
  await browserNavigate('a', 'back'); await browserNavigate('a', 'forward'); await browserNavigate('a', 'reload')
  expect(page.reload).toHaveBeenCalledExactlyOnceWith({ waitUntil: 'commit', timeout: 15000 })
  expect(page.goBack).toHaveBeenCalledOnce(); expect(page.goForward).toHaveBeenCalledOnce()
  await expect(browserNavigate('b', 'reload')).rejects.toThrow('Open a website')
  await expect(browserNavigate('a', 'reset')).rejects.toThrow('Unknown navigation')
  session.send.mockRejectedValueOnce(new Error('closed'))
  await expect(browserHistory('a')).rejects.toThrow('closed')
  expect(session.detach).toHaveBeenCalledTimes(2)
})
it('validates and routes viewport measurements without changing another lane', async () => {
  await browserResize('a', 640, 480)
  expect(fake.resize).toHaveBeenCalledExactlyOnceWith(480, 'a', 640)
  await expect(browserResize('b', Infinity, 200)).rejects.toThrow('Invalid')
  expect(fake.resize).toHaveBeenCalledOnce()
})
