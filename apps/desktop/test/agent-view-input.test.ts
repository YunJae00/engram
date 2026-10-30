import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  native: false, active: 'bot-one', pages: new Map<string, unknown>(),
  broadcast: vi.fn(), preview: vi.fn(), input: vi.fn(),
}))
vi.mock('../src/main/agent-browser.js', () => ({
  activeLaneName: () => deps.active,
  setActiveLane: (lane: string) => { deps.active = lane },
  lanePage: (lane: string) => deps.pages.get(lane),
  ensureAgentPage: async (lane: string) => deps.pages.get(lane),
  laneOf: (page: unknown) => [...deps.pages].find(([, held]) => held === page)?.[0],
}))
vi.mock('../src/main/native-browser.js', () => ({ isNativePage: () => deps.native, setNativeInputSink: vi.fn() }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: deps.broadcast }))
vi.mock('../src/main/page-actions.js', () => ({ setPointerSink: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/page-preview.js', () => ({
  withPreviewInput: deps.input,
  captureSharpFrame: vi.fn(async () => ({ data: 'frame', width: 1280, height: 860 })),
  startPagePreview: deps.preview,
}))

function fixture(lane: string) {
  const cdp = { send: vi.fn(async () => undefined), detach: vi.fn(async () => undefined) }
  const page = Object.assign(new EventEmitter(), {
    context: () => ({ newCDPSession: async () => cdp }), isClosed: () => false,
    viewportSize: () => ({ width: 1280, height: 860 }), url: () => `https://${lane}.example`,
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
  })
  deps.pages.set(lane, page)
  return { page, cdp }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  deps.input.mockImplementation(async (_page: unknown, input: () => Promise<unknown>) => input())
  deps.pages.clear()
  deps.active = 'bot-one'
  deps.native = false
})

describe('browser view handoffs', () => {
  it('drops input queued behind a capture when the selected chat changes', async () => {
    const first = fixture('bot-one')
    fixture('bot-two')
    let resume!: () => Promise<void>
    deps.input.mockImplementation((_page: unknown, input: () => Promise<void>) => new Promise<void>(resolve => {
      resume = async () => { await input(); resolve() }
    }))
    const view = await import('../src/main/agent-view.js')
    await view.lookAtLane('bot-one')
    const pending = view.agentViewInput({ kind: 'text', text: 'Do not type into the old chat' }, 'bot-one')
    await view.lookAtLane('bot-two')
    await resume()
    await pending
    expect(first.cdp.send).not.toHaveBeenCalled()
  })
  it('reports a failed navigation without discarding the existing page or its mirror', async () => {
    const first = fixture('bot-one'), second = fixture('bot-two')
    const failure = new Error('page.goto: net::ERR_CONNECTION_REFUSED')
    first.page.goto.mockRejectedValueOnce(failure)
    const view = await import('../src/main/agent-view.js')
    await view.lookAtLane('bot-one')
    const before = view.agentViewState()

    await expect(view.agentViewGo('http://127.0.0.1:1/', 'bot-one')).rejects.toBe(failure)

    expect(first.page.goto).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:1/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    expect(second.page.goto).not.toHaveBeenCalled()
    expect(deps.pages.get('bot-one')).toBe(first.page)
    expect(view.agentViewState()).toEqual(before)
    expect(first.cdp.detach).not.toHaveBeenCalled()
  })

  it('returns after the requested lane loads its document', async () => {
    const first = fixture('bot-one'), second = fixture('bot-two')
    const view = await import('../src/main/agent-view.js')
    await expect(view.agentViewGo('https://example.com/', 'bot-two')).resolves.toBeUndefined()
    expect(first.page.goto).not.toHaveBeenCalled()
    expect(second.page.goto).toHaveBeenCalledExactlyOnceWith('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
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

  it('maps input against the current viewport rather than a stale mirrored frame', async () => {
    const { page, cdp } = fixture('bot-one')
    const view = await import('../src/main/agent-view.js')
    await view.lookAtLane('bot-one')
    vi.spyOn(page, 'viewportSize').mockReturnValue({ width: 696, height: 768 })
    await view.agentViewInput({ kind: 'mouse', type: 'wheel', x: 0.5, y: 0.5, deltaY: 4000 }, 'bot-one')
    expect(cdp.send).toHaveBeenCalledTimes(2)
    expect(cdp.send).toHaveBeenNthCalledWith(1, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 348, y: 384, modifiers: 0 })
    expect(cdp.send).toHaveBeenNthCalledWith(2, 'Input.synthesizeScrollGesture', { x: 348, y: 384, xDistance: -0, yDistance: -4000, gestureSourceType: 'mouse', speed: 10000, preventFling: true })
    expect(view.touchedAt('bot-one')).toBe(0)
  })

  it('keeps the input pending until Chromium acknowledges scrolling, preserving modified and native-browser wheels', async () => {
    const { cdp } = fixture('bot-one')
    let finish!: () => void
    cdp.send.mockImplementation(async method => {
      if (method === 'Input.synthesizeScrollGesture') await new Promise<void>(resolve => { finish = resolve })
    })
    const view = await import('../src/main/agent-view.js')
    await view.lookAtLane('bot-one')
    let ended = false
    const pending = view.agentViewInput({ kind: 'mouse', type: 'wheel', x: 0.5, y: 0.5, deltaY: 120 }, 'bot-one').then(() => { ended = true })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(ended).toBe(false)
    finish()
    await pending
    await view.agentViewInput({ kind: 'mouse', type: 'wheel', x: 0.5, y: 0.5, deltaY: 120, modifiers: 2 }, 'bot-one')
    expect(cdp.send).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseWheel', modifiers: 2, deltaY: 120 }))
    deps.native = true
    await view.agentViewInput({ kind: 'mouse', type: 'wheel', x: 0.5, y: 0.5, deltaY: 120 }, 'bot-one')
    expect(cdp.send).toHaveBeenLastCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseWheel', modifiers: 0, deltaY: 120 }))
  })

  it('waits for painting before a wheel and drops it if the chat changes meanwhile', async () => {
    const { page, cdp } = fixture('bot-one')
    fixture('bot-two')
    let painted!: () => void
    page.evaluate.mockImplementationOnce(() => new Promise<void>(resolve => { painted = resolve }))
    const view = await import('../src/main/agent-view.js')
    await view.lookAtLane('bot-one')
    const input = view.agentViewInput({ kind: 'mouse', type: 'wheel', x: 0.5, y: 0.5, deltaY: 4000 }, 'bot-one')
    await vi.waitFor(() => expect(painted).toBeTypeOf('function'))
    expect(cdp.send).toHaveBeenCalledTimes(1)
    await view.lookAtLane('bot-two')
    painted()
    await input
    expect(cdp.send.mock.calls.some(call => call[1]?.type === 'mouseWheel')).toBe(false)
  })
})
