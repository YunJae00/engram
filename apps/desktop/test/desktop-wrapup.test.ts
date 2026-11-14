import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({
  binding: { lane: 'bot-one', source: 'window:42:0', name: 'ChatGPT', window: '42', pid: 55, readable: true, revision: 0, host: { request: vi.fn() } },
  lookup: vi.fn(), observe: vi.fn(), read: vi.fn(), act: vi.fn(), open: vi.fn(), sequence: vi.fn(),
}))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: vi.fn() }))
vi.mock('../src/main/desktop-permission.js', async () => { const { desktopFailure } = await import('../src/main/desktop-failure.js'); return { permissionFailure: async (error: unknown, _lane: string, options?: Parameters<typeof desktopFailure>[1]) => desktopFailure(error, options) } })
vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: vi.fn(), desktopBinding: fake.lookup, desktopWindows: vi.fn(), catalogHost: () => ({ request: async () => [{ id: 'chatgpt', name: 'ChatGPT' }] }) }))
vi.mock('../src/main/desktop-control.js', () => ({ desktopObservation: fake.observe, setDesktopHandoverReset: vi.fn(), startDesktopControl: vi.fn(), openDesktopApp: fake.open, assertDesktopTurnNotStopped: vi.fn(), readControlledDesktop: fake.read, actOnDesktop: fake.act, desktopControlStatus: () => ({ lane: 'bot-one', state: 'running' }), withDesktopActivity: (_lane: string, run: () => Promise<unknown>) => run() }))
vi.mock('../src/main/desktop-sequence.js', () => ({ desktopSequence: fake.sequence }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: { available: () => true } }))
vi.mock('../src/main/desktop-quiet.js', () => ({ quietVerdict: () => ({ verdict: 'bare', title: 'ChatGPT' }), quietScan: vi.fn(), quietSnapshot: vi.fn(), quietSet: vi.fn(), quietPress: vi.fn(), quietText: vi.fn(), quietControlName: vi.fn() }))
import { desktopAgentTools, forgetTypedUnsent } from '../src/main/desktop-agent.js'
import { desktopInputArgs } from '../src/main/desktop-input-args.js'
import { outcomeChain } from '../src/main/desktop-outcome.js'
import { STILL_CHANGING } from '../src/main/desktop-settle.js'

const TASK = '챗지피티 앱 열고 hello만 써 놓아 줘'
const view = (value: string, name = 'Message'): DesktopObservationDto => ({
  snapshot: 's1', truncated: false, focusedControl: 'f1', bounds: { x: 0, y: 0, width: 100, height: 100 },
  nodes: [{ id: 'e1', runtimeId: 'f1', controlType: 'AXTextArea', name, value, bounds: { x: 0, y: 0, width: 100, height: 20 } },
    { id: 'e2', runtimeId: 'b1', controlType: 'AXButton', name: 'New chat', bounds: { x: 0, y: 40, width: 20, height: 20 } }],
})
type Json = Record<string, unknown> & { outcome?: { done: boolean; stillMoving: boolean; reason?: string; summary: string } }
const approveAppAction = vi.fn(async () => true)
const turn = (task = TASK) => {
  const tools = desktopAgentTools('bot-one')
  return async (name: string, args: Record<string, unknown>): Promise<Json> => JSON.parse(await tools.find(one => one.name === name)!.run(args, { task, approveAppAction } as never)) as Json
}
const pressed = () => [...fake.act.mock.calls.map(([, action]) => action as { kind: string }), ...fake.binding.host.request.mock.calls.map(([method]) => ({ kind: method as string }))].filter(one => one.kind === 'key')

beforeEach(() => {
  vi.clearAllMocks()
  forgetTypedUnsent('bot-one')
  fake.lookup.mockImplementation(() => fake.binding)
  fake.open.mockImplementation(async (_lane: string, _app: string, _signal: unknown, attachOnly?: boolean) => attachOnly ? '' : JSON.stringify({ opened: true, alreadyOpen: false, title: 'ChatGPT', windowVerified: true }))
  fake.binding.host.request = vi.fn(async (_method: string, args: Record<string, unknown>) => ({ sent: true, strategy: 'selected-text', expected: args['text'] }))
  fake.act.mockImplementation(async (_lane: string, action: { kind: string }) => { await fake.binding.host.request(action.kind, desktopInputArgs(action as never, view(''), {})); return 'dispatched' })
  fake.read.mockResolvedValue(view('hello'))
  fake.observe.mockImplementation(() => view(''))
})

describe('desktop wrap-up', () => {
  it('opens the app and leaves hello unsent', async () => {
    const run = turn()
    expect((await run('open_app', { app: 'ChatGPT' }))['opened']).toBe(true)
    await run('read_desktop', {})
    const typed = await run('desktop_action', { kind: 'type', snapshot: 's1', text: 'hello' })
    expect(typed['typed']).toMatchObject({ verified: true })
    expect(Object.keys(typed)[0]).toBe('outcome')
    expect(typed.outcome).toMatchObject({ done: true, stillMoving: false })
    expect(typed.outcome!.summary).toBe('ChatGPT 열고 입력창에 hello 써 뒀어. 보내진 않았어.')
    expect(pressed()).toEqual([])
    expect(approveAppAction).not.toHaveBeenCalled()
  })

  it('says not done with the reason', async () => {
    const missing = await turn()('open_app', { app: 'NoSuchApp' })
    expect(missing.outcome).toMatchObject({ done: false })
    expect(missing.outcome!.summary).toMatch(/^못 했어\. NoSuchApp 앱을 열지 못했어/)
    fake.read.mockResolvedValue(view('hell'))
    const differs = await turn()('desktop_action', { kind: 'type', snapshot: 's1', text: 'hello' })
    expect(differs.outcome).toMatchObject({ done: false, stillMoving: false, reason: '입력창에 "hell"가 들어가 있어' })
    expect(differs.outcome!.summary).toContain('못 했어')
    fake.read.mockResolvedValue(view('draft hello'))
    const draft = await turn()('desktop_action', { kind: 'type', snapshot: 's1', text: 'hello' })
    expect(draft['typed']).toMatchObject({ verified: false })
    expect(draft.outcome).toMatchObject({ done: false, reason: '입력창에 "draft hello"가 들어가 있어' })
    fake.read.mockResolvedValue(view('hello'))
    const english = await turn('open ChatGPT and type hello')('open_app', { app: 'NoSuchApp' })
    expect(english.outcome!.summary).toMatch(/^Not done: could not open NoSuchApp/)

    const add = (chain: ReturnType<typeof outcomeChain>, tool: string, args: Record<string, unknown>, result: object) => JSON.parse(chain.add(tool, args, JSON.stringify(result), TASK, 'ChatGPT')) as Json
    const chain = outcomeChain()
    expect(add(chain, 'open_app', { app: 'ChatGPT' }, { opened: true, title: 'ChatGPT' }).outcome).toBeUndefined()
    expect(add(chain, 'desktop_action', { kind: 'click' }, { dispatched: true }).outcome).toBeUndefined()
    expect(add(chain, 'desktop_action', { kind: 'type', text: 'hello' }, { typed: { verified: false, landed: 'hell' } }).outcome).toMatchObject({ done: false })
    expect(add(chain, 'app_press', {}, { dispatched: true }).outcome).toMatchObject({ done: false, reason: '입력창에 "hell"가 들어가 있어' })
    expect(add(chain, 'app_set', { text: 'hello' }, { landed: true, exact: false, value: 'hell' }).outcome).toMatchObject({ done: false })
    expect(add(chain, 'app_press', {}, { landed: true }).outcome).toMatchObject({ done: false })
    expect(add(chain, 'app_set', { text: 'hello' }, { landed: true, exact: true, value: 'priorhello' }).outcome).toMatchObject({ done: false, reason: '입력창에 "priorhello"가 들어가 있어' })
    expect(add(chain, 'app_set', { text: 'hello' }, { landed: true, exact: true, value: 'hello' }).outcome).toMatchObject({ done: true, summary: 'ChatGPT 열고 입력창에 hello 써 뒀어. 보내진 않았어.' })
    expect(add(chain, 'app_press', {}, { landed: true }).outcome).toMatchObject({ done: true, summary: '했어.' })
    expect(add(chain, 'desktop_action', { kind: 'key' }, { error: 'accessibility_denied', permission: 'accessibility' }).outcome!.reason).toContain('손쉬운 사용')
    expect(add(outcomeChain(), 'desktop_sequence', { actions: [{ kind: 'type', text: 'hello' }] }, { completed: 1, error: 'element_not_found' }).outcome).toMatchObject({ done: false, reason: '입력창을 찾지 못했어' })
  })

  it('retries a missed click once after a fresh read', async () => {
    fake.read.mockResolvedValue(view(''))
    const run = turn()
    await run('open_app', { app: 'ChatGPT' })
    await run('read_desktop', {})
    const reads = fake.read.mock.calls.length
    const result = await run('desktop_action', { kind: 'click', snapshot: 's1', element: 'e2' })
    const clicks = fake.act.mock.calls.filter(([, action]) => (action as { kind: string }).kind === 'click')
    expect(clicks).toHaveLength(2)
    const between = fake.read.mock.invocationCallOrder.slice(reads).filter(order => order > fake.act.mock.invocationCallOrder[0]! && order < fake.act.mock.invocationCallOrder[1]!)
    expect(between.length).toBeGreaterThan(0)
    expect(result).toMatchObject({ retried: 1, noEffect: expect.any(String) })
    expect(result.outcome).toMatchObject({ done: false })
    expect(result.outcome!.summary).toContain('못 했어')
  })

  it('never claims done while the window is moving', async () => {
    const chain = outcomeChain()
    const moving = JSON.parse(chain.add('desktop_action', { kind: 'type', text: 'hello' }, JSON.stringify({ typed: { verified: true }, observation: view('hello'), stillChanging: STILL_CHANGING }), TASK, 'ChatGPT')) as Json
    expect(moving.outcome).toMatchObject({ done: false, stillMoving: true })
    expect(moving.outcome!.summary).toContain('못 했어')
    expect(moving.outcome!.summary).not.toContain('써 뒀어')
    const sequence = JSON.parse(outcomeChain().add('desktop_sequence', { actions: [{ kind: 'type', text: 'hello' }] }, JSON.stringify({ completed: 1, error: STILL_CHANGING }), TASK, 'ChatGPT')) as Json
    expect(sequence.outcome).toMatchObject({ done: false, stillMoving: true })
    let count = 0
    fake.read.mockImplementation(async () => view('hello', `Message ${count++}`))
    const typed = await turn()('desktop_action', { kind: 'type', snapshot: 's1', text: 'hello' })
    expect(typed['stillChanging']).toBe(STILL_CHANGING)
    expect(typed.outcome).toMatchObject({ done: false, stillMoving: true })
  })
})
