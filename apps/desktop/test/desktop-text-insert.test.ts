import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({
  binding: { lane: 'bot-one', source: 'window:42:0', name: 'Fixture', window: '42', pid: 55, readable: true, revision: 0, host: { request: vi.fn() } },
  lookup: vi.fn(), observe: vi.fn(), read: vi.fn(), act: vi.fn(), start: vi.fn(), sequence: vi.fn(),
}))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: vi.fn() }))
vi.mock('../src/main/desktop-permission.js', async () => { const { desktopFailure } = await import('../src/main/desktop-failure.js'); return { permissionFailure: async (error: unknown, _lane: string, options?: Parameters<typeof desktopFailure>[1]) => desktopFailure(error, options) } })
vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: vi.fn(), desktopBinding: fake.lookup, desktopWindows: vi.fn() }))
vi.mock('../src/main/desktop-control.js', () => ({ desktopObservation: fake.observe, setDesktopHandoverReset: vi.fn(), startDesktopControl: fake.start, openDesktopApp: vi.fn(), assertDesktopTurnNotStopped: vi.fn(), readControlledDesktop: fake.read, actOnDesktop: fake.act, desktopControlStatus: () => ({ lane: 'bot-one', state: 'running' }), withDesktopActivity: (_lane: string, run: () => Promise<unknown>) => run() }))
vi.mock('../src/main/desktop-sequence.js', () => ({ desktopSequence: fake.sequence }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: { available: () => true } }))
vi.mock('../src/main/desktop-quiet.js', () => ({ quietVerdict: () => ({ verdict: 'bare', title: 'Fixture' }), quietScan: vi.fn(), quietSnapshot: vi.fn(), quietSet: vi.fn(), quietPress: vi.fn(), quietText: vi.fn(), quietControlName: vi.fn() }))
import { desktopAgentTools, forgetTypedUnsent } from '../src/main/desktop-agent.js'
import { desktopInputArgs } from '../src/main/desktop-input-args.js'
import { typeArgs, typedReport } from '../src/main/desktop-text-insert.js'

const HELLO = '안녕하세요, 테스트입니다'
const field = (value: string | null): DesktopObservationDto => ({
  snapshot: 'after', truncated: false, focusedControl: 'f1', bounds: { x: 0, y: 0, width: 100, height: 100 },
  nodes: [{ id: 'e1', runtimeId: 'f1', controlType: 'AXTextArea', name: 'Message', value, bounds: { x: 0, y: 0, width: 100, height: 20 } }],
})
const tool = (name: string) => desktopAgentTools('bot-one').find(one => one.name === name)!
const run = async (name: string, args: unknown, approve?: () => Promise<boolean>) =>
  JSON.parse(await tool(name).run(args as Record<string, unknown>, { task: 'Write a draft', ...(approve ? { approveAppAction: approve } : {}) } as never)) as Record<string, unknown>
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

beforeEach(() => {
  vi.clearAllMocks()
  forgetTypedUnsent('bot-one')
  fake.lookup.mockImplementation(() => fake.binding)
  fake.binding.host.request = vi.fn(async (_method: string, args: Record<string, unknown>) => ({ sent: true, strategy: 'selected-text', expected: args['text'] }))
  fake.act.mockImplementation(async (_lane: string, action: { kind: string }) => { await fake.binding.host.request(action.kind, desktopInputArgs(action as never, field(''), {})); return 'dispatched' })
  fake.read.mockResolvedValue(field(HELLO))
  fake.observe.mockImplementation(() => ({ ...field(''), nodes: [...field('').nodes, { id: 'e2', controlType: 'AXButton', name: 'Send message', bounds: { x: 0, y: 40, width: 20, height: 20 } }] }))
})

describe('desktop text insertion', () => {
  it('inserts Korean as one chunk', async () => {
    expect(typeArgs(HELLO)).toEqual({ text: HELLO, chunks: [HELLO] })
    expect(typeArgs(HELLO.normalize('NFD'))).toEqual({ text: HELLO, chunks: [HELLO] })
    const args = desktopInputArgs({ kind: 'type', snapshot: 's', text: HELLO.normalize('NFD') }, field(''), {})
    expect(args).toMatchObject({ text: HELLO, chunks: [HELLO] })
    expect(args).not.toHaveProperty('key')
    const result = await run('desktop_action', { kind: 'type', snapshot: 's', text: HELLO })
    expect(fake.act).toHaveBeenCalledOnce()
    expect(fake.binding.host.request).toHaveBeenCalledWith('type', expect.objectContaining({ text: HELLO, chunks: [HELLO] }))
    expect(result['typed']).toEqual({ strategy: 'selected-text', insert: 'one-piece', verified: true })
  })

  it('chunks long text at 20 units', () => {
    const text = '가'.repeat(19) + '😀' + '나'.repeat(40) + '👩‍👩‍👧'
    const { chunks } = typeArgs(text)
    expect(chunks.join('')).toBe(text.normalize('NFC'))
    for (const chunk of chunks) { expect(chunk.length).toBeLessThanOrEqual(20); expect(lone.test(chunk)).toBe(false) }
    expect(chunks[0]).toBe('가'.repeat(19))
    expect(() => typeArgs('a'.repeat(2001))).toThrow()
    const report = typedReport(text, { strategy: 'keys', expected: text }, field(text))
    expect(report).toEqual({ strategy: 'keys', insert: 'chunked', verified: true })
    expect(typedReport(HELLO, { strategy: 'keys', expected: HELLO }, field(HELLO)).insert).toBe('one-piece')
    expect(typedReport(HELLO, undefined, field(HELLO))).toMatchObject({ strategy: 'unknown', verified: false })
  })

  it('reports what landed when the field differs', async () => {
    expect(typedReport(HELLO, { strategy: 'keys', expected: HELLO }, field('ㅇㅏㄴㄴㅕㅇ'))).toMatchObject({ verified: false, landed: 'ㅇㅏㄴㄴㅕㅇ' })
    expect(typedReport(HELLO, { strategy: 'selected-text', expected: HELLO }, field(`${HELLO}ㅇ`))).toMatchObject({ verified: false, landed: `${HELLO}ㅇ` })
    expect(typedReport(HELLO, { strategy: 'selected-text', expected: HELLO }, field(HELLO.normalize('NFD')))).toMatchObject({ verified: true })
    expect(typedReport(HELLO, { strategy: 'selected-text', expected: HELLO }, field(null))).toMatchObject({ verified: false, hint: expect.stringContaining('could not be read back') })
    fake.read.mockResolvedValue(field('ㅇㅏㄴ'))
    expect((await run('desktop_action', { kind: 'type', snapshot: 's', text: HELLO }))['typed']).toMatchObject({ verified: false, landed: 'ㅇㅏㄴ' })
    fake.act.mockRejectedValueOnce(new Error('The field does not hold the typed text (keys). It now reads: "ㅇㅏㄴ". Tell the person what landed; do not type it again or send'))
    const failed = await run('desktop_action', { kind: 'type', snapshot: 's', text: HELLO })
    expect(failed['delivery']).not.toBe('not_delivered')
    expect(failed['reason']).toContain('ㅇㅏㄴ')
    fake.sequence.mockResolvedValueOnce(JSON.stringify({ completed: 1, dispatched: 1, failedStep: 2, error: 'The field could not be read back after typing (keys). Look at the field before saying it is done; do not send' }))
    const sequence = await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', element: 'e1' }, { kind: 'type', text: HELLO }] })
    expect(sequence['delivery']).toBe('delivery_uncertain')
  })

  it('never presses Enter while typing', async () => {
    await run('desktop_action', { kind: 'type', snapshot: 's', text: HELLO })
    for (const [, action] of fake.act.mock.calls) expect(action).toMatchObject({ kind: 'type' })
    expect(fake.binding.host.request.mock.calls.every(([method, args]) => method === 'type' && !('key' in args))).toBe(true)
    expect(() => typeArgs('a\nb')).toThrow()
    expect(() => typeArgs('a\rb')).toThrow()
    fake.act.mockClear()
    const decline = vi.fn(async () => false)
    expect(await run('desktop_action', { kind: 'key', snapshot: 's', key: 'Enter' }, decline)).toMatchObject({ error: 'policy_denied', delivery: 'not_delivered' })
    expect(await run('desktop_action', { kind: 'key', snapshot: 's', key: 'Enter' })).toMatchObject({ error: 'policy_denied' })
    expect(fake.act).not.toHaveBeenCalled()
    const approve = vi.fn(async () => true)
    await run('desktop_action', { kind: 'key', snapshot: 's', key: 'Enter' }, approve)
    expect(approve).toHaveBeenCalledWith('Fixture', 'Send', 's')
    expect(fake.act).toHaveBeenCalledOnce()
    expect(fake.act.mock.calls[0]![1]).toMatchObject({ key: 'Enter' })
    fake.act.mockClear(); approve.mockClear()
    const typeThenSend = await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', element: 'e1' }, { kind: 'type', text: HELLO }, { kind: 'key', key: 'Enter' }] }, approve)
    expect(typeThenSend).toMatchObject({ error: 'policy_denied', delivery: 'not_delivered' })
    expect(approve).not.toHaveBeenCalled()
    expect(await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', element: 'e1' }, { kind: 'key', key: 'Enter' }] }, decline)).toMatchObject({ error: 'policy_denied' })
    // A later Enter is refused too: [click, Enter, type, Enter] would send the new text without a read-back or its own approval.
    const enterTypeEnter = await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', element: 'e1' }, { kind: 'key', key: 'Enter' }, { kind: 'type', text: HELLO }, { kind: 'key', key: 'Enter' }] }, approve)
    expect(enterTypeEnter).toMatchObject({ error: 'policy_denied', delivery: 'not_delivered' })
    expect(approve).not.toHaveBeenCalled()
    expect(fake.act).not.toHaveBeenCalled()
    expect(fake.sequence).not.toHaveBeenCalled()
  })

  it('asks before clicking a Send control', async () => {
    const decline = vi.fn(async () => false)
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e2' }, decline)).toMatchObject({ error: 'policy_denied', delivery: 'not_delivered' })
    expect(decline).toHaveBeenCalledWith('Fixture', 'Send', 's')
    expect(fake.act).not.toHaveBeenCalled()
    const approve = vi.fn(async () => true)
    expect(await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', element: 'e1' }, { kind: 'type', text: HELLO }, { kind: 'click', element: 'e2' }] }, approve)).toMatchObject({ error: 'policy_denied', delivery: 'not_delivered' })
    expect(await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', element: 'e2' }] }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(approve).not.toHaveBeenCalled()
    expect(fake.sequence).not.toHaveBeenCalled()
    await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e1' }, decline)
    expect(fake.act).toHaveBeenCalledOnce()
    // By position or by name, a click on Send asks too.
    fake.act.mockClear(); decline.mockClear()
    fake.observe.mockImplementation(() => ({ ...field(''), captureBounds: { x: 0, y: 0, width: 101, height: 101 }, nodes: [...field('').nodes, { id: 'e2', controlType: 'AXButton', name: 'Send message', bounds: { x: 0, y: 40, width: 20, height: 20 } }] }))
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', x: 0.1, y: 0.5 }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', target: { name: 'Send message', controlType: 'AXButton' } }] }, decline)).toMatchObject({ error: 'policy_denied' })
    // The dispatched pixel is rounded: a point just outside the button's fractional edge still lands on it.
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', x: 0.204, y: 0.5 }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(decline).toHaveBeenCalledTimes(3)
    expect(fake.act).not.toHaveBeenCalled()
  })

  it('asks before Space on a focused button and before any non-field click after typing', async () => {
    const decline = vi.fn(async () => false)
    const icon = { id: 'e3', runtimeId: 'b3', controlType: 'AXButton', name: '', bounds: { x: 60, y: 40, width: 20, height: 20 } }
    fake.observe.mockImplementation(() => ({ ...field(''), focusedControl: 'b3', nodes: [...field('').nodes, icon] }))
    expect(await run('desktop_action', { kind: 'key', snapshot: 's', key: 'Space' }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(fake.act).not.toHaveBeenCalled()
    // Before typing, an unnamed button click is an ordinary click.
    await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e3' }, decline)
    expect(fake.act).toHaveBeenCalledOnce()
    fake.act.mockClear()
    // After typing, the same icon-only button may be Send: it asks, while clicking back into the field does not.
    await run('desktop_action', { kind: 'type', snapshot: 's', text: HELLO })
    fake.act.mockClear()
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e3' }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(fake.act).not.toHaveBeenCalled()
    await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e1' }, decline)
    expect(fake.act).toHaveBeenCalledOnce()
    expect(decline).toHaveBeenCalledTimes(2)
    // A type whose read-back fails still leaves a draft: the icon button keeps asking, and a new tool set (next turn) remembers it.
    forgetTypedUnsent('bot-one'); fake.act.mockClear(); decline.mockClear()
    fake.read.mockRejectedValueOnce(new Error('read failed'))
    await run('desktop_action', { kind: 'type', snapshot: 's', text: HELLO })
    fake.act.mockClear()
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e3' }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(fake.act).not.toHaveBeenCalled()
  })

  it('asks before an icon button sends a draft the person typed, and keeps the draft when an approved send fails', async () => {
    const decline = vi.fn().mockResolvedValue(false)
    const icon = { id: 'e3', runtimeId: 'b3', controlType: 'AXButton', name: '', bounds: { x: 60, y: 40, width: 20, height: 20 } }
    fake.observe.mockImplementation(() => ({ ...field(HELLO), nodes: [...field(HELLO).nodes, icon] }))
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e3' }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(fake.act).not.toHaveBeenCalled()
    fake.observe.mockImplementation(() => ({ ...field(HELLO), nodes: [...field(HELLO).nodes, { ...icon, name: '↑' }] }))
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e3' }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(fake.act).not.toHaveBeenCalled()
    fake.observe.mockImplementation(() => ({ ...field(''), nodes: [...field('').nodes, icon] }))
    await run('desktop_action', { kind: 'type', snapshot: 's', text: HELLO })
    fake.act.mockClear()
    fake.act.mockRejectedValueOnce(new Error('dispatch failed'))
    await run('desktop_action', { kind: 'key', snapshot: 's', key: 'Enter' }, vi.fn().mockResolvedValue(true))
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', element: 'e3' }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(fake.act).toHaveBeenCalledOnce()
    // A position click where an icon button overlaps the field still asks.
    fake.observe.mockImplementation(() => ({ ...field(''), captureBounds: { x: 0, y: 0, width: 101, height: 101 }, nodes: [...field('').nodes.map(node => ({ ...node, bounds: { x: 0, y: 0, width: 100, height: 60 } })), icon] }))
    expect(await run('desktop_action', { kind: 'click', snapshot: 's', x: 0.7, y: 0.5 }, decline)).toMatchObject({ error: 'policy_denied' })
    expect(fake.act).toHaveBeenCalledOnce()
  })

  it('reports the strategy and read-back of text typed in a sequence', async () => {
    fake.sequence.mockImplementation(async () => { await fake.binding.host.request('type', { text: HELLO }); return JSON.stringify({ completed: 2, observation: field(HELLO), requiresVerification: true }) })
    const done = await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', element: 'e1' }, { kind: 'type', text: HELLO }] })
    expect(done['typed']).toEqual({ strategy: 'selected-text', insert: 'one-piece', verified: true })
    fake.read.mockResolvedValue(field(HELLO + 'ㅇ'))
    fake.sequence.mockImplementation(async () => { await fake.binding.host.request('type', { text: HELLO }); return JSON.stringify({ completed: 2, observation: field(HELLO + 'ㅇ'), requiresVerification: true }) })
    const off = await run('desktop_sequence', { snapshot: 's', actions: [{ kind: 'click', element: 'e1' }, { kind: 'type', text: HELLO }] })
    expect(off['typed']).toMatchObject({ verified: false, landed: HELLO + 'ㅇ' })
  })
})
