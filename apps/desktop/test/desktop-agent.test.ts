import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({
  binding: { lane: 'bot-one', source: 'window:42:0', name: 'Fixture', window: '42', pid: 55, readable: true, revision: 0, host: { request: vi.fn() } },
  controlReason: undefined as string | undefined, resetHandover: undefined as (() => void) | undefined, assertNotStopped: vi.fn(), quietScan: vi.fn(), quietSnapshot: vi.fn(), quietPress: vi.fn(), quietSet: vi.fn(),
  open: vi.fn(), lookup: vi.fn(), read: vi.fn(), act: vi.fn(), bitmap: vi.fn(), image: vi.fn(), decode: vi.fn(), start: vi.fn(), ensure: vi.fn(), windows: vi.fn(), available: true, covered: false, handedOver: true,
}))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: vi.fn() }))
vi.mock('../src/main/desktop-permission.js', async () => { const { desktopFailure } = await import('../src/main/desktop-failure.js'); return { permissionFailure: async (error: unknown, _lane: string, options?: Parameters<typeof desktopFailure>[1]) => desktopFailure(error, options) } })
vi.mock('electron', () => ({ nativeImage: { createFromBitmap: fake.image, createFromBuffer: fake.decode } }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: fake.ensure, desktopBinding: fake.lookup, desktopWindows: fake.windows }))
vi.mock('../src/main/desktop-control.js', () => ({ setDesktopHandoverReset: (_lane: string, reset: () => void) => { fake.resetHandover = reset }, startDesktopControl: fake.start, openDesktopApp: fake.open, assertDesktopTurnNotStopped: fake.assertNotStopped, readControlledDesktop: fake.read, actOnDesktop: fake.act, desktopControlStatus: () => fake.controlReason ? { lane: 'bot-one', state: 'paused', reason: fake.controlReason } : fake.handedOver ? { lane: 'bot-one', state: 'running' } : { state: 'idle' }, withDesktopActivity: (_lane: string, run: () => Promise<unknown>) => run() }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: { available: () => fake.available } }))
vi.mock('../src/main/desktop-quiet.js', () => ({ quietVerdict: (_lane: string, app?: string) => fake.covered ? (!app || app === 'Fixture' ? { verdict: 'covered', title: 'Fixture' } : { verdict: 'bare', title: app }) : { verdict: 'bare', title: app ?? 'Fixture' }, quietScan: fake.quietScan, quietSnapshot: fake.quietSnapshot, quietSet: fake.quietSet, quietPress: fake.quietPress, quietText: vi.fn(), quietControlName: (_snapshot: string, control: string) => control === 'c404' ? undefined : control === 'c9' ? 'Send' : 'New chat' }))
import { desktopAgentTools, desktopContext } from '../src/main/desktop-agent.js'

const observation = (snapshot = 'fresh'): DesktopObservationDto => ({
  snapshot, truncated: false, nodes: [], bounds: { x: -10, y: 20, width: 40, height: 40 },
  captureBounds: { x: -8, y: 24, width: 32, height: 32 }, protectedBounds: [{ x: 8, y: 40, width: 1, height: 1 }],
})
const captured = () => ({ basis: 'client-physical', bounds: observation().captureBounds, width: 32, height: 32, data: Buffer.from('encoded-image').toString('base64') })
function look(signal?: AbortSignal) {
  return desktopAgentTools('bot-one').find((item) => item.name === 'look_desktop')!.runRich!({}, { task: 'Inspect the fixture', ...(signal ? { signal } : {}) })
}
beforeEach(() => {
  vi.clearAllMocks()
  fake.binding = { lane: 'bot-one', source: 'window:42:0', name: 'Fixture', window: '42', pid: 55, readable: true, revision: 0, host: { request: vi.fn().mockResolvedValue(captured()) } }
  fake.lookup.mockImplementation(() => fake.binding)
  fake.available = true
  fake.covered = false
  fake.handedOver = true
  fake.controlReason = undefined
  fake.start.mockImplementation(async () => { fake.handedOver = true; return { lane: 'bot-one', state: 'ready' } })
  fake.quietSnapshot.mockReturnValue(undefined)
  fake.ensure.mockImplementation(async () => fake.binding)
  fake.windows.mockResolvedValue([{ id: 'window:42:0', name: 'Fixture', foreground: true }, { id: 'window:43:0', name: 'Notes' }])
  fake.read.mockResolvedValue(observation())
  fake.bitmap.mockImplementation(() => Buffer.alloc(32 * 32 * 4, 255))
  fake.decode.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }), toBitmap: fake.bitmap })
  fake.image.mockReturnValue({ toJPEG: () => Buffer.from('fixture-image') })
})
describe('desktop image consent and capture validation', () => {
  it('keeps task context aligned with observation reuse and guarded batches', () => {
    expect(desktopContext()).toContain('desktop_sequence')
    expect(desktopContext()).toContain('returned observation')
    expect(desktopContext()).not.toContain('After every action, observe')
  })
  it('always reads after a replacement and does not retry when readback fails', async () => {
    const tool = desktopAgentTools('bot-one').find((one) => one.name === 'desktop_action')!
    const args = { kind: 'replace', snapshot: 'before', element: 'e1', expected: 'Old', text: 'New' }
    const result = JSON.parse(await tool.run(args, { task: 'Replace the entire field' }))
    expect(result).toMatchObject({ dispatched: true, requiresVerification: true, observation: { snapshot: 'fresh' } })
    expect(fake.act).toHaveBeenCalledOnce()
    expect(fake.read).toHaveBeenCalledOnce()
    fake.act.mockClear(); fake.read.mockClear()
    fake.read.mockRejectedValueOnce(new Error('Readback unavailable'))
    expect(JSON.parse(await tool.run(args, { task: 'Replace the entire field' }))).toEqual({
      dispatched: true, reason: 'Readback unavailable', error: 'action_failed', delivery: 'delivered_unverified', retry: 'unsafe', hint: expect.any(String), observationMayBeStale: true, requiresVerification: true,
    })
    expect(fake.act).toHaveBeenCalledOnce()
    expect(fake.read).toHaveBeenCalledOnce()
  })
  it('propagates cancellation during readback without presenting a recoverable result', async () => {
    const controller = new AbortController()
    fake.read.mockImplementationOnce(async () => { controller.abort(); throw new Error('Readback interrupted') })
    const tool = desktopAgentTools('bot-one').find((one) => one.name === 'desktop_action')!
    await expect(tool.run({ kind: 'type', snapshot: 'before', text: 'Draft' }, { task: 'Enter a draft', signal: controller.signal })).rejects.toThrow()
    expect(fake.act).toHaveBeenCalledOnce()
    expect(fake.read).toHaveBeenCalledOnce()
  })
  it('returns a fresh partial observation after input without claiming task completion', async () => {
    fake.read.mockResolvedValue({ ...observation('after'), truncated: true })
    const tool = desktopAgentTools('bot-one').find((one) => one.name === 'desktop_action')!
    const result = JSON.parse(await tool.run({ kind: 'key', snapshot: 'before', key: 'Shift+Home' }, { task: 'Select the current line' }))
    expect(result.observation.snapshot).toBe('after')
    expect(result.observation.truncated).toBe(true)
    expect(result.requiresVerification).toBe(true)
    expect(fake.act).toHaveBeenCalledOnce()
    expect(fake.read).toHaveBeenCalledOnce()
  })
  it('never retakes control after Escape and never retries an input error', async () => {
    const tool = desktopAgentTools('bot-one').find((one) => one.name === 'desktop_action')!
    expect(await tool.run({ kind: 'key', snapshot: 'before', key: 'Escape' }, { task: 'Stop' })).toContain('ended')
    expect(fake.read).not.toHaveBeenCalled()
    fake.act.mockRejectedValueOnce(new Error('First native failure'))
    expect(JSON.parse(await tool.run({ kind: 'key', snapshot: 'before', key: 'Home' }, { task: 'Move' }))).toMatchObject({ error: 'action_failed', delivery: 'delivery_uncertain', retry: 'unsafe' })
    expect(fake.read).not.toHaveBeenCalled()
  })
  it('offers the computer whenever this build can drive it, and never without the helper', async () => {
    fake.available = false
    expect(desktopAgentTools('bot-one')).toEqual([])
    expect(desktopContext()).toBe('')
    fake.available = true
    const tools = desktopAgentTools('bot-one')
    expect(tools.map((tool) => tool.name)).toEqual(['app_read', 'app_set', 'app_press', 'app_text', 'list_apps', 'open_app', 'list_windows', 'read_desktop', 'look_desktop', 'desktop_action', 'desktop_sequence', 'read_live_document', 'edit_live_document', 'compose_live_document'])
    expect(desktopContext()).toContain('control approval card')
    expect(await tools.find((tool) => tool.name === 'list_windows')!.run({}, { task: 'Inspect the fixture' })).toBe('- window:42:0 Fixture (in front)' + String.fromCharCode(10) + '- window:43:0 Notes')
    expect(fake.binding.host.request).not.toHaveBeenCalled()
  })
  it('a look binds the named app without acquiring foreground control', async () => {
    fake.read.mockResolvedValueOnce(observation('before')).mockResolvedValueOnce(observation('after'))
    await desktopAgentTools('bot-one').find((item) => item.name === 'look_desktop')!.runRich!({ app: 'Fixture' }, { task: 'Inspect the fixture' })
    expect(fake.ensure).toHaveBeenCalledWith('bot-one', { app: 'Fixture' })
    expect(fake.read).toHaveBeenCalledWith('bot-one', undefined)
  })
  it('masks using client coordinates and returns the latest snapshot', async () => {
    fake.read.mockResolvedValueOnce(observation('before')).mockResolvedValueOnce(observation('after'))
    const result = await look()
    expect(fake.binding.host.request).toHaveBeenCalledWith('capture', { window: '42', pid: 55, snapshot: 'before' }, undefined)
    expect(fake.read).toHaveBeenCalledTimes(2)
    expect(result.text).toContain('"snapshot":"after"')
    expect(result.image?.mimeType).toBe('image/jpeg')
    const pixels = fake.image.mock.calls[0]![0] as Buffer
    const offset = (16 * 32 + 16) * 4
    expect([...pixels.subarray(offset, offset + 4)]).toEqual([32, 32, 32, 255])
    expect([...pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255])
  })
  it('accepts partial text only with explicit native capture clearance on both observations', async () => {
    fake.read.mockResolvedValue({ ...observation(), truncated: true, captureSafe: true })
    expect((await look()).image?.mimeType).toBe('image/jpeg')
    fake.read.mockResolvedValueOnce({ ...observation(), truncated: true, captureSafe: true }).mockResolvedValueOnce({ ...observation(), truncated: true, captureSafe: false })
    expect(JSON.parse((await look()).text).reason).toContain('accessibility scan was incomplete')
  })
  it.each([true, undefined, 'false', 0])('does not capture with incomplete coverage (%s)', async (truncated) => {
    fake.read.mockResolvedValueOnce({ ...observation(), truncated })
    expect(JSON.parse((await look()).text).reason).toContain('Use read_desktop')
    expect(fake.binding.host.request).not.toHaveBeenCalled()
  })
  it.each([true, undefined, 'false', 0])('discards pixels after incomplete follow-up (%s)', async (truncated) => {
    fake.read.mockResolvedValueOnce(observation()).mockResolvedValueOnce({ ...observation(), truncated })
    expect(JSON.parse((await look()).text).reason).toContain('accessibility scan was incomplete')
    expect(fake.decode).not.toHaveBeenCalled()
  })
  it.each(['bounds', 'captureBounds', 'protectedBounds'] as const)('rejects changed %s', async (field) => {
    const after = observation()
    if (field === 'protectedBounds') after.protectedBounds![0]!.x++
    else after[field]!.x++
    fake.read.mockResolvedValueOnce(observation()).mockResolvedValueOnce(after)
    expect(JSON.parse((await look()).text).reason).toContain('window changed')
    expect(fake.image).not.toHaveBeenCalled()
  })
  it.each(['missing', 'invalid', 'protected'] as const)('rejects %s geometry before capture', async (kind) => {
    const invalid = observation()
    if (kind === 'missing') delete invalid.captureBounds
    else if (kind === 'invalid') invalid.captureBounds!.width = Number.NaN
    else invalid.protectedBounds![0]!.height = 0
    fake.read.mockResolvedValueOnce(invalid)
    expect(JSON.parse((await look()).text).reason).toContain('safe screenshot geometry')
    expect(fake.binding.host.request).not.toHaveBeenCalled()
  })
  it('discards an image after identity validation fails', async () => {
    fake.read.mockResolvedValueOnce(observation()).mockRejectedValueOnce(new Error('Window replaced'))
    expect(JSON.parse((await look()).text).reason).toContain('replaced')
    expect(fake.image).not.toHaveBeenCalled()
  })
  it.each(['permission', 'replacement', 'abort'] as const)('discards delayed capture after %s', async (change) => {
    let resolve!: (value: unknown) => void
    fake.binding.host.request.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const controller = new AbortController()
    const capture = look(controller.signal)
    const pending = change === 'abort' ? expect(capture).rejects.toThrow() : expect(capture).resolves.toMatchObject({ text: expect.stringContaining('action_failed') })
    await vi.waitFor(() => expect(fake.binding.host.request).toHaveBeenCalled())
    if (change === 'permission') fake.binding.readable = false
    else if (change === 'replacement') fake.binding = { ...fake.binding, revision: 1 }
    else controller.abort()
    resolve(captured())
    await pending
    expect(fake.image).not.toHaveBeenCalled()
  })
  it.each(['basis', 'bounds', 'data'] as const)('rejects unverified native %s', async (field) => {
    const value = captured()
    if (field === 'basis') value.basis = 'outer-window'
    else if (field === 'bounds') value.bounds = observation().bounds
    else value.data = '?'
    fake.binding.host.request.mockResolvedValueOnce(value)
    expect(JSON.parse((await look()).text).reason).toContain('verified screenshot geometry')
    expect(fake.decode).not.toHaveBeenCalled()
  })
  it('rejects an invalid bitmap size', async () => {
    fake.bitmap.mockReturnValueOnce(Buffer.alloc(1))
    expect(JSON.parse((await look()).text).reason).toContain('invalid screenshot')
    expect(fake.image).not.toHaveBeenCalled()
  })
})

describe('the quiet lane keeps the apps it has read', () => {
  it('honors explicit handover even when some app controls are readable', async () => {
    fake.covered = true
    const tools = desktopAgentTools('bot-one')
    const context = { task: 'Inspect the fixture' }
    await tools.find((tool) => tool.name === 'read_desktop')!.run({ app: 'Fixture' }, context)
    await tools.find((tool) => tool.name === 'look_desktop')!.runRich!({ app: 'Fixture' }, context)
    await tools.find((tool) => tool.name === 'desktop_action')!.run({ kind: 'click', snapshot: 'fresh', element: 'e0' }, context)
    expect(fake.read).toHaveBeenCalledTimes(4)
    expect(fake.act).toHaveBeenCalledOnce()
    await tools.find((tool) => tool.name === 'read_desktop')!.run({ app: 'Notes' }, context)
    expect(fake.read).toHaveBeenCalledTimes(5)
  })
})

describe('a quiet press', () => {
  it('returns the app read again, and counts as committed only for a control that cannot be taken back', async () => {
    vi.useFakeTimers()
    try {
      fake.quietPress.mockResolvedValue({ pressed: 'invoke', control: 'c3' })
      fake.quietScan.mockResolvedValue({ window: '7', pid: 70, title: 'ChatGPT', snapshot: 'b'.repeat(32), controls: [{ id: 'c1', type: 'Edit', name: 'Message', can: { set: true, press: false, text: true }, enabled: true, offscreen: false, focused: false, secret: false }], texts: [], skippedControls: 0, skippedTexts: 0, ms: 50, state: { foreground: false, idleMs: 9000, minimized: false } })
      const press = desktopAgentTools('bot-one').find((tool) => tool.name === 'app_press')!
      const committed = vi.fn(), observed = vi.fn()
      const opening = press.run({ app: 'ChatGPT', snapshot: 'a'.repeat(32), control: 'c3' }, { task: 'Open a chat', onCommitted: committed, onObservedAfterAction: observed })
      await vi.advanceTimersByTimeAsync(400)
      const result = await opening
      expect(JSON.parse(result)).toMatchObject({ pressed: 'invoke', appNow: expect.any(String) })
      expect(result).toContain('snapshot ' + 'b'.repeat(32))
      expect(committed).not.toHaveBeenCalled()
      expect(observed).toHaveBeenCalledOnce()
      fake.quietSnapshot.mockReturnValue(await fake.quietScan())
      const sending = press.run({ app: 'ChatGPT', snapshot: 'a'.repeat(32), control: 'c9' }, Object.assign({ task: 'Send it', onCommitted: committed }, { approveAppAction: async () => true }))
      await vi.advanceTimersByTimeAsync(400)
      await sending
      expect(committed).toHaveBeenCalledOnce()
      observed.mockClear()
      fake.quietScan.mockRejectedValueOnce(new Error('Readback unavailable'))
      const failedRead = press.run({ app: 'ChatGPT', snapshot: 'a'.repeat(32), control: 'c3' }, { task: 'Open a chat', onObservedAfterAction: observed })
      await vi.advanceTimersByTimeAsync(400)
      expect(JSON.parse(await failedRead)).toMatchObject({ pressed: 'invoke', observationMayBeStale: true, error: 'action_failed', delivery: 'delivered_unverified', retry: 'unsafe' })
      expect(observed).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})

it('returns an unsafe unverified receipt when a container press leaves the app unchanged', async () => {
  const previous = { window: '7', pid: 70, title: 'Fixture', snapshot: 'a'.repeat(32),
    controls: [{ id: 'c3', type: 'TreeItem', name: 'Entry', can: { set: false, press: true, text: false }, enabled: true, offscreen: false, focused: false, secret: false }],
    texts: [], skippedControls: 0, skippedTexts: 0, ms: 1, state: { foreground: false, idleMs: 9000, minimized: false } }
  fake.quietSnapshot.mockReturnValue(previous)
  fake.quietPress.mockResolvedValue({ pressed: 'select', control: 'c3' })
  fake.quietScan.mockResolvedValue({ ...previous, snapshot: 'b'.repeat(32) })
  const press = desktopAgentTools('bot-one').find(tool => tool.name === 'app_press')!
  const result = JSON.parse(await press.run({ app: 'Fixture', snapshot: previous.snapshot, control: 'c3' }, { task: 'Open the entry' }))
  expect(result).toMatchObject({ delivery: 'delivered_unverified', retry: 'unsafe', appNow: expect.any(String), hint: expect.stringContaining('inner actionable cell or button') })
  expect(fake.quietPress).toHaveBeenCalledOnce()
  expect(fake.quietScan).toHaveBeenCalledOnce()
})

it('allows screenshots without handover but refuses global input before dispatch', async () => {
  fake.handedOver = false
  expect((await look()).image).toBeDefined()
  const tool = desktopAgentTools('bot-one').find(tool => tool.name === 'desktop_action')!
  const result = JSON.parse(await tool.run({ kind: 'type', snapshot: 'fresh', text: 'Draft' }, { task: 'Draft' }))
  expect(result).toMatchObject({ error: 'policy_denied', delivery: 'not_delivered', retry: 'safe' })
  expect(result.hint).toContain('declined')
  expect(fake.act).not.toHaveBeenCalled()
})


it('requires an explicit app when no window is bound instead of reading the human foreground', async () => {
  fake.lookup.mockReturnValue(undefined)
  const read = desktopAgentTools('bot-one').find(tool => tool.name === 'read_desktop')!
  expect(JSON.parse(await read.run({}, { task: 'Read' })).reason).toContain('Name the app')
  expect(JSON.parse((await look()).text).reason).toContain('Name the app')
  expect(fake.ensure).not.toHaveBeenCalled()
  expect(fake.read).not.toHaveBeenCalled()
})

it('preserves the Accessibility permission boundary in the model observation', async () => {
  fake.quietScan.mockRejectedValueOnce(new Error('Allow Engram in System Settings → Privacy & Security → Accessibility'))
  const tool = desktopAgentTools('bot-one').find(tool => tool.name === 'app_read')!
  const result = JSON.parse(await tool.run({ app: 'Fixture' }, { task: 'Read the fixture' }))
  expect(result).toMatchObject({ error: 'accessibility_denied', delivery: 'not_delivered' })
  expect(result.hint).toContain('System Settings → Privacy & Security → Accessibility')
  expect(result.hint).not.toContain('not found')
})

it('does not treat a requested read or a model press argument as approval to send', async () => {
  const press = desktopAgentTools('bot-one').find(tool => tool.name === 'app_press')!
  const committed = vi.fn()
  fake.quietSnapshot.mockReturnValue({ window: '42', pid: 55, title: 'Fixture', controls: [], texts: [] })
  const result = await press.run({ app: 'Fixture', snapshot: 'a'.repeat(32), control: 'c9' }, { task: 'Read the conversation', onCommitted: committed })
  expect(JSON.parse(result)).toMatchObject({ error: 'policy_denied', delivery: 'not_delivered', retry: 'unsafe' })
  expect(fake.quietPress).not.toHaveBeenCalled()
  expect(committed).not.toHaveBeenCalled()
})

it('returns a stale reference instead of requesting permission when a control disappeared', async () => {
  const approveAppAction = vi.fn(async () => true)
  const press = desktopAgentTools('bot-one').find(tool => tool.name === 'app_press')!
  const result = await press.run({ app: 'Fixture', snapshot: 'a'.repeat(32), control: 'c404' }, Object.assign({ task: 'Open the conversation' }, { approveAppAction }))
  expect(JSON.parse(result)).toMatchObject({ error: 'stale_snapshot', delivery: 'not_delivered', retry: 'safe' })
  expect(approveAppAction).not.toHaveBeenCalled()
  expect(fake.quietPress).not.toHaveBeenCalled()
})

it('does not press when the target conversation changes during approval', async () => {
  const before = { window: '42', pid: 55, title: 'Fixture', controls: [], texts: [{ id: 't1', text: 'Recipient A' }] }
  fake.quietSnapshot.mockReturnValue(before)
  fake.quietScan.mockResolvedValue({ ...before, texts: [{ id: 't1', text: 'Recipient B' }] })
  const approveAppAction = vi.fn(async () => true)
  const press = desktopAgentTools('bot-one').find(tool => tool.name === 'app_press')!
  const result = await press.run({ app: 'Fixture', snapshot: 'a'.repeat(32), control: 'c9' }, Object.assign({ task: 'Send if approved' }, { approveAppAction }))
  expect(JSON.parse(result)).toMatchObject({ error: 'stale_snapshot', delivery: 'not_delivered' })
  expect(approveAppAction).toHaveBeenCalledWith('Fixture', 'Send', 'a'.repeat(32))
  expect(fake.quietPress).not.toHaveBeenCalled()
})

it.each(['read_desktop', 'look_desktop', 'list_windows', 'open_app'])('wraps permission denial consistently for %s', async name => {
  const error = new Error('Allow Engram in System Settings → Privacy & Security → Accessibility')
  fake.ensure.mockRejectedValue(error)
  fake.windows.mockRejectedValue(error)
  fake.open.mockRejectedValue(error)
  const tool = desktopAgentTools('bot-one').find(item => item.name === name)!
  const args = name === 'open_app' ? { app: 'a'.repeat(64) } : { }
  const result = tool.runRich ? (await tool.runRich(args, { task: 'Read' })).text : await tool.run(args, { task: 'Read' })
  expect(JSON.parse(result)).toMatchObject({ error: 'accessibility_denied', retry: 'blocked' })
})

it('explains blocked permission retries and the settings link on app_read', () => {
  const description = desktopAgentTools('bot-one').find(tool => tool.name === 'app_read')!.description
  expect(description).toContain('retry:blocked')
  expect(description).toContain('settingsUrl')
})


it.each([true, false])('continues only after the foreground approval card is accepted (%s)', async approved => {
  fake.handedOver = false
  const { desktopOptIn } = await import('../src/main/desktop-opt-in.js')
  const ask = vi.fn(async () => approved ? 'approve' as const : 'cancel' as const)
  const tool = desktopOptIn(desktopAgentTools('bot-one'), { enabled: async () => true, enable: vi.fn(), ask }).find(item => item.name === 'desktop_action')!
  const args = { kind: 'type', snapshot: 'fresh', text: 'Draft' }
  const first = JSON.parse(await tool.run(args, { task: 'Draft' }))
  await tool.run(args, { task: 'Draft' })
  expect(ask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ url: 'engram://computer-control/bot-one' }))
  if (approved) {
    expect(first.dispatched).toBe(true)
    expect(fake.start).toHaveBeenCalledOnce()
    expect(fake.act).toHaveBeenCalledTimes(2)
  } else {
    expect(first).toMatchObject({ error: 'policy_denied', delivery: 'not_delivered', reason: expect.stringContaining('declined by the person') })
    expect(fake.start).not.toHaveBeenCalled()
    expect(fake.act).not.toHaveBeenCalled()
  }
})

it('does not start foreground control after cancellation during approval', async () => {
  fake.handedOver = false
  const { desktopOptIn } = await import('../src/main/desktop-opt-in.js')
  const controller = new AbortController()
  const tool = desktopOptIn(desktopAgentTools('bot-one'), { enabled: async () => true, enable: vi.fn(), ask: async () => { controller.abort(); return 'approve' } }).find(item => item.name === 'desktop_action')!
  await expect(tool.run({ kind: 'type', snapshot: 'fresh', text: 'Draft' }, { task: 'Draft', signal: controller.signal })).rejects.toThrow()
  expect(fake.start).not.toHaveBeenCalled()
  expect(fake.act).not.toHaveBeenCalled()
})


it('reports revocation after a cached handover without claiming the person declined', async () => {
  fake.handedOver = false
  const approveComputerControl = vi.fn(async () => true)
  const tool = desktopAgentTools('bot-one').find(tool => tool.name === 'desktop_action')!
  const args = { kind: 'type', snapshot: 'fresh', text: 'Draft' }
  const context = Object.assign({ task: 'Draft' }, { approveComputerControl })
  await tool.run(args, context)
  fake.handedOver = false
  fake.resetHandover?.()
  fake.controlReason = 'User input changed'
  const result = JSON.parse(await tool.run(args, context))
  expect(result).toMatchObject({ error: 'policy_denied', hint: 'The person took the computer back. Ask before requesting foreground control again.' })
  expect(result.reason).not.toContain('declined')
  expect(approveComputerControl).toHaveBeenCalledOnce()
  expect(fake.act).toHaveBeenCalledOnce()
})

it.each([['Enter', 'c3'], ['Control+Enter', 'c3'], ['Enter', 'c9'], ['Control+Enter', 'c9']])('requires send approval for %s on editors and send controls', async (key, control) => {
  fake.quietSnapshot.mockReturnValue({ controls: [{ id: control, type: 'Edit', value: 'Draft', can: { set: control === 'c3' } }], texts: [] })
  const approveAppAction = vi.fn(async () => false)
  const tool = desktopAgentTools('bot-one').find(item => item.name === 'app_press')!
  const result = await tool.run({ app: 'Fixture', snapshot: 'a'.repeat(32), control, key }, Object.assign({ task: 'Send' }, { approveAppAction }))
  expect(JSON.parse(result).delivery).toBe('not_delivered')
  expect(approveAppAction).toHaveBeenCalledWith('Fixture', 'Send', 'a'.repeat(32))
  expect(fake.quietPress).not.toHaveBeenCalled()
})

it('remaps nearby controls to the fresh post-set snapshot by runtime identity', async () => {
  fake.quietSet.mockResolvedValue({ snapshot: 'a'.repeat(32), nearby: [{ id: 'c10020', runtimeId: 'send-runtime', name: 'Send', appeared: true }], landed: true })
  fake.quietScan.mockResolvedValue({ snapshot: 'b'.repeat(32), controls: [{ id: 'c7', runtimeId: 'send-runtime', name: 'Send', type: 'Button', can: { press: true } }], texts: [], skippedTexts: 0, state: { foreground: false } })
  const tool = desktopAgentTools('bot-one').find(tool => tool.name === 'app_set')!
  const result = JSON.parse(await tool.run({ app: 'Fixture', snapshot: 'a'.repeat(32), control: 'c3', text: 'Draft' }, { task: 'Draft' }))
  expect(result.nearby).toEqual([expect.objectContaining({ id: 'c7', snapshot: 'b'.repeat(32), appeared: true })])
})
