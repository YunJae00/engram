import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  active: 'bot-one', pages: new Map<string, unknown>(),
  broadcast: vi.fn(), preview: vi.fn(),
}))
vi.mock('../src/main/agent-browser.js', () => ({
  activeLaneName: () => deps.active,
  setActiveLane: (lane: string) => { deps.active = lane },
  lanePage: (lane: string) => deps.pages.get(lane),
  ensureAgentPage: async (lane: string) => deps.pages.get(lane),
  laneOf: (page: unknown) => [...deps.pages].find(([, held]) => held === page)?.[0],
}))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: deps.broadcast }))
vi.mock('../src/main/page-actions.js', () => ({ setPointerSink: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/page-preview.js', () => ({
  captureSharpFrame: vi.fn(async () => ({ data: 'frame', width: 1280, height: 860 })),
  startPagePreview: deps.preview,
}))

function fixture(lane: string) {
  const cdp = { send: vi.fn(async () => undefined), detach: vi.fn(async () => undefined) }
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: async () => cdp }), isClosed: () => false,
    viewportSize: () => ({ width: 1280, height: 860 }), url: () => `https://${lane}.example`,
    goto: vi.fn(async () => undefined),
  })
  deps.pages.set(lane, page)
  return { page, cdp }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  deps.pages.clear()
  deps.active = 'bot-one'
})

describe('browser view handoffs', () => {
  it('reports a failed navigation without discarding the existing page or its mirror', async () => {
    const first = fixture('bot-one'), second = fixture('bot-two')
    const failure = new Error('page.goto: net::ERR_CONNECTION_REFUSED')
    first.page.goto.mockRejectedValueOnce(failure)
    const view = await import('../src/main/agent-view.js')
    await view.lookAtLane('bot-one')
    const before = view.agentViewState()

    await expect(view.agentViewGo('http://127.0.0.1:1/', 'bot-one')).rejects.toBe(failure)

    expect(first.page.goto).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:1/', { waitUntil: 'commit' })
    expect(second.page.goto).not.toHaveBeenCalled()
    expect(deps.pages.get('bot-one')).toBe(first.page)
    expect(view.agentViewState()).toEqual(before)
    expect(first.cdp.detach).not.toHaveBeenCalled()
  })

  it('returns normally after the requested lane commits a navigation', async () => {
    const first = fixture('bot-one'), second = fixture('bot-two')
    const view = await import('../src/main/agent-view.js')
    await expect(view.agentViewGo('https://example.com/', 'bot-two')).resolves.toBeUndefined()
    expect(first.page.goto).not.toHaveBeenCalled()
    expect(second.page.goto).toHaveBeenCalledExactlyOnceWith('https://example.com/', { waitUntil: 'commit' })
  })

  it('drops keyboard and wheel input from a chat that is no longer selected', async () => {
    const first = fixture('bot-one'), second = fixture('bot-two')
    const view = await import('../src/main/agent-view.js')
    await view.lookAtLane('bot-one')
    await view.agentViewInput({ kind: 'text', text: 'first' }, 'bot-one')
    expect(first.cdp.send).toHaveBeenCalledWith('Input.insertText', { text: 'first' })
    await view.lookAtLane('bot-two')
    await view.agentViewInput({ kind: 'text', text: 'stale' }, 'bot-one')
    await view.agentViewInput({ kind: 'mouse', type: 'wheel', x: 0.5, y: 0.5, deltaY: 100 }, 'bot-one')
    expect(second.cdp.send).not.toHaveBeenCalled()
    await view.agentViewInput({ kind: 'text', text: '한글' }, 'bot-two')
    expect(second.cdp.send).toHaveBeenCalledExactlyOnceWith('Input.insertText', { text: '한글' })
  })

  it('releases a superseded startup without replacing the current stream lease', async () => {
    fixture('bot-one')
    const starts: ((stop: () => void) => void)[] = []
    deps.preview.mockImplementation(() => new Promise((resolve) => starts.push(resolve)))
    const view = await import('../src/main/agent-view.js')
    await view.lookAtLane('bot-one')
    const opening = view.watchAgentView(true)
    await view.watchAgentView(false)
    const reopening = view.watchAgentView(true)
    const oldStop = vi.fn(), currentStop = vi.fn()
    starts[1]!(currentStop)
    await reopening
    starts[0]!(oldStop)
    await opening
    expect(oldStop).toHaveBeenCalledOnce()
    expect(currentStop).not.toHaveBeenCalled()
    await view.watchAgentView(false)
    expect(currentStop).toHaveBeenCalledOnce()
  })
})
