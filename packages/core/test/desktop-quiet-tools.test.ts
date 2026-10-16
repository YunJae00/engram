import { describe, expect, it, vi } from 'vitest'
import { quietDesktopTools, type QuietCourier } from '../src/desktop-quiet-tools.js'
import { desktopStepArgs, desktopStepSummary, isDesktopTool } from '../src/desktop-tools.js'

const SNAPSHOT = 'a'.repeat(32)
const CONTEXT = { task: 'Ask Claude Desktop about the mail.' }

function setup() {
  const courier: QuietCourier = {
    scan: vi.fn(async () => '{"snapshot":"' + SNAPSHOT + '"}'),
    set: vi.fn(async () => '{"landed":true}'),
    press: vi.fn(async () => '{"pressed":"invoke"}'),
    text: vi.fn(async () => '{"text":"answer"}'),
  }
  const tools = quietDesktopTools(courier)
  const tool = (name: string) => tools.find((one) => one.name === name)!
  return { courier, tools, tool }
}

describe('quiet app tools', () => {
  it('offers app_do only with a courier and keeps its arguments and committed receipt guarded', async () => {
    const { courier, tools } = setup()
    expect(tools.some(tool => tool.name === 'app_do')).toBe(false)
    const run = vi.fn(async () => '{"status":"done","pressed":true,"committed":true}')
    const tool = quietDesktopTools({ ...courier, do: run }).find(tool => tool.name === 'app_do')!
    const committed = vi.fn()
    expect(isDesktopTool(tool.name)).toBe(true)
    await tool.run({ app: 'Notes', goal: 'Open the draft', text: 'hello' }, { ...CONTEXT, onCommitted: committed })
    expect(committed).toHaveBeenCalledOnce()
    expect(desktopStepArgs('app_do', { app: 'Notes', goal: 'private', text: 'private' })).toEqual({ app: 'Notes', goal: '[redacted]', text: '[redacted]' })
    expect(await tool.run({ app: 'Notes', goal: 'Open draft', maxSteps: 100 }, CONTEXT)).toContain('maxSteps from 1 to 12')
    await expect(tool.run({ app: 'Notes', goal: 'Set text', text: 'token sk-proj-abcdefghijklmnopqrstuvwxyz' }, CONTEXT)).rejects.toThrow(/secret/i)
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('are desktop tools with plain step labels and redacted text', () => {
    for (const name of ['app_read', 'app_set', 'app_press', 'app_text']) expect(isDesktopTool(name)).toBe(true)
    expect(desktopStepSummary('app_read', { app: 'Claude' })).toBe('read Claude')
    expect(desktopStepSummary('app_set', { app: 'Claude', text: 'hello' })).toBe('set text in Claude')
    expect(desktopStepSummary('app_press', { app: 'Claude' })).toBe('press in Claude')
    expect(desktopStepSummary('app_text', {})).toBe('read text from the app')
    expect(desktopStepArgs('app_set', { app: 'Claude', snapshot: SNAPSHOT, control: 'c1', text: 'secret-ish', expected: 'old' })).toEqual({ app: 'Claude', snapshot: SNAPSHOT, control: 'c1', text: '[redacted]', expected: '[redacted]' })
  })

  it('reads an app by a title word, with an optional find phrase', async () => {
    const { courier, tool } = setup()
    expect(await tool('app_read').run({ app: ' Claude ' }, CONTEXT)).toContain(SNAPSHOT)
    expect(courier.scan).toHaveBeenCalledWith('Claude', undefined, undefined)
    await tool('app_read').run({ app: 'Claude', find: 'Send' }, CONTEXT)
    expect(courier.scan).toHaveBeenLastCalledWith('Claude', 'Send', undefined)
    expect(await tool('app_read').run({}, CONTEXT)).toContain('takes app')
    expect(await tool('app_read').run({ app: 'Claude', extra: 1 }, CONTEXT)).toContain('takes app')
    expect(courier.scan).toHaveBeenCalledTimes(2)
  })

  it('sets text only with a snapshot and a control from the read, and never a secret', async () => {
    const { courier, tool } = setup()
    expect(await tool('app_set').run({ app: 'Claude', snapshot: SNAPSHOT, control: 'c3', text: 'Summarize the mail\nfrom today' }, CONTEXT)).toContain('landed')
    expect(courier.set).toHaveBeenCalledWith('Claude', SNAPSHOT, 'c3', 'Summarize the mail\nfrom today', undefined, CONTEXT)
    await tool('app_set').run({ app: 'Claude', snapshot: SNAPSHOT, control: 'c3', text: 'new', expected: 'old' }, CONTEXT)
    expect(courier.set).toHaveBeenLastCalledWith('Claude', SNAPSHOT, 'c3', 'new', 'old', CONTEXT)
    expect(await tool('app_set').run({ app: 'Claude', snapshot: 'short', control: 'c3', text: 'x' }, CONTEXT)).toContain('needs the snapshot')
    expect(await tool('app_set').run({ app: 'Claude', snapshot: SNAPSHOT, control: 'e3', text: 'x' }, CONTEXT)).toContain('needs the snapshot')
    await expect(tool('app_set').run({ app: 'Claude', snapshot: SNAPSHOT, control: 'c3', text: 'token sk-proj-abcdefghijklmnopqrstuvwxyz' }, CONTEXT)).rejects.toThrow(/secret/i)
    expect(courier.set).toHaveBeenCalledTimes(2)
  })

  it('presses a control and leaves deciding what committed to the host', async () => {
    const { courier, tool } = setup()
    const onCommitted = vi.fn()
    expect(await tool('app_press').run({ app: 'Claude', snapshot: SNAPSHOT, control: 'c7' }, { ...CONTEXT, onCommitted })).toContain('invoke')
    expect(courier.press).toHaveBeenCalledWith('Claude', SNAPSHOT, 'c7', expect.objectContaining({ task: CONTEXT.task }))
    expect(onCommitted).not.toHaveBeenCalled()
    expect(await tool('app_press').run({ app: 'Claude', snapshot: SNAPSHOT }, CONTEXT)).toContain('takes app, snapshot and control')
  })

  it('reads text for the window or one control, settling for an answer still being written', async () => {
    const { courier, tool } = setup()
    expect(await tool('app_text').run({ app: 'Claude' }, CONTEXT)).toContain('answer')
    expect(courier.text).toHaveBeenCalledWith('Claude', undefined, undefined, 0, undefined)
    await tool('app_text').run({ app: 'Claude', snapshot: SNAPSHOT, control: 't12', settleSeconds: 8 }, CONTEXT)
    expect(courier.text).toHaveBeenLastCalledWith('Claude', SNAPSHOT, 't12', 8, undefined)
    expect(await tool('app_text').run({ app: 'Claude', control: 't12' }, CONTEXT)).toContain('optional snapshot with control')
    expect(await tool('app_text').run({ app: 'Claude', settleSeconds: 500 }, CONTEXT)).toContain('settleSeconds from 0 to 120')
    expect(courier.text).toHaveBeenCalledTimes(2)
  })
})
