import { EventEmitter } from 'node:events'
import type { Page } from 'playwright-core'
import { expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ page: null as Page | null, watcher: null as ((page: Page, lane: string) => void) | null }))
vi.mock('../src/main/agent-browser.js', () => ({
  activeLaneName: () => 'one', lanePage: () => state.page, laneOf: () => 'one',
  setActiveLane: vi.fn(), watchAgentPages: (fn: typeof state.watcher) => { state.watcher = fn },
}))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/page-actions.js', () => ({ setPointerSink: vi.fn() }))
vi.mock('../src/main/native-browser.js', () => ({ isNativePage: () => true, setNativeInputSink: vi.fn() }))
vi.mock('../src/main/page-preview.js', () => ({}))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { agentViewState, lookAtLane, startAgentView } from '../src/main/agent-view.js'

test('a late notification from an older tab cannot replace the selected page', async () => {
  const page = (url: string) => Object.assign(new EventEmitter(), {
    url: () => url, isClosed: () => false, viewportSize: () => null,
    context: () => ({ newCDPSession: async () => ({ detach: vi.fn().mockResolvedValue(undefined) }) }),
  }) as unknown as Page
  const first = page('https://first.test'), second = page('https://second.test')
  startAgentView()
  state.page = first
  await lookAtLane('one')
  state.page = second
  await lookAtLane('one')
  state.watcher!(first, 'one')
  await new Promise(resolve => setImmediate(resolve))
  expect(agentViewState().url).toBe('https://second.test')
})
