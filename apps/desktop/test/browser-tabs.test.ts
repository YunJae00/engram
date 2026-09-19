import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ handlers: new Map(), pages: [] as unknown[], selected: null as unknown, watch: null as unknown, busy: false }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: unknown) => mocks.handlers.set(name, fn) } }))
vi.mock('../src/main/agent-browser.js', () => ({
  activeLaneName: () => 'one',
  lanePages: (lane: string) => lane === 'one' ? mocks.pages : [],
  lanePage: () => mocks.selected,
  selectLanePage: (_lane: string, page: unknown) => { mocks.selected = page },
  addAgentPage: vi.fn(),
  watchAgentPages: (fn: unknown) => { mocks.watch = fn },
}))
vi.mock('../src/main/agent-view.js', () => ({ lookAtLane: vi.fn() }))
vi.mock('../src/main/native-layout.js', () => ({ refreshNativeLayout: vi.fn() }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { registerBrowserTabs } from '../src/main/browser-tabs.js'

test('tab selection stays within its conversation and cannot interrupt an active task', async () => {
  const page = Object.assign(new EventEmitter(), { url: () => 'https://example.com', title: async () => 'Fixture title', isClosed: () => false, close: vi.fn() })
  mocks.pages = [page]
  registerBrowserTabs(() => mocks.busy)
  const read = mocks.handlers.get('agent:tabs')
  const change = mocks.handlers.get('agent:tab')
  ;(mocks.watch as (page: unknown, lane: string) => void)(page, 'one')
  await new Promise(resolve => setImmediate(resolve))
  expect(read(null, 'one')[0].title).toBe('Fixture title')
  const [tab] = read(null, 'one')
  await change(null, 'one', 'select', tab.id)
  expect(read(null, 'one')[0].active).toBe(true)
  await expect(change(null, 'two', 'close', tab.id)).rejects.toThrow('this conversation')
  mocks.busy = true
  await expect(change(null, 'one', 'close', tab.id)).rejects.toThrow('Stop the current task')
  expect(page.close).not.toHaveBeenCalled()
  expect(() => read(null, '<invalid>')).toThrow('Invalid browser conversation')
})
