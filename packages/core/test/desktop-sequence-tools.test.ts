import { expect, it, vi } from 'vitest'
import { desktopTools, desktopStepArgs, isDesktopTool } from '../src/desktop-tools.js'
it('validates the entire sequence before sending any input and redacts its text', async () => {
  const sequence = vi.fn(async () => 'observed result')
  const tool = desktopTools({ read: async () => '', sequence }).find((one) => one.name === 'desktop_sequence')!
  expect(await tool.run({ snapshot: 'fresh', actions: [{ kind: 'click', element: 'e1' }, { kind: 'type', text: 'Hello' }] }, { task: 'Type Hello' })).toBe('observed result')
  expect(sequence).toHaveBeenCalledWith([{ kind: 'click', snapshot: 'fresh', element: 'e1' }, { kind: 'type', snapshot: 'fresh', text: 'Hello' }], { task: 'Type Hello' })
  sequence.mockClear()
  for (const actions of [[], Array(13).fill({ kind: 'key', key: 'Tab' }), [{ kind: 'click', x: 0.2, y: 0.3 }], [{ kind: 'key', key: 'Windows' }], [{ kind: 'type', text: 'Bearer 123456789abc' }]]) {
    await expect(tool.run({ snapshot: 'fresh', actions }, { task: '' })).rejects.toThrow()
  }
  expect(sequence).not.toHaveBeenCalled()
  expect(isDesktopTool('desktop_sequence')).toBe(true)
  expect(JSON.stringify(desktopStepArgs('desktop_sequence', { snapshot: 'fresh', actions: [{ text: 'private text' }] }))).not.toContain('private text')
})

it('validates named batches and checkpoints completely before dispatch', async () => {
  const sequence = vi.fn(async () => 'checked')
  const tool = desktopTools({ read: async () => '', sequence }).find((one) => one.name === 'desktop_sequence')!
  const target = { name: 'Draft', controlType: 'Edit' }
  const actions = [{ kind: 'type', target, text: 'Hello' }, { kind: 'verify', target, value: 'Hello' }]
  expect(await tool.run({ snapshot: 'fresh', actions }, { task: 'Type Hello' })).toBe('checked')
  expect(sequence).toHaveBeenCalledWith(actions.map((action) => ({ ...action, snapshot: 'fresh' })), { task: 'Type Hello' })
  sequence.mockClear()
  for (const bad of [
    [{ kind: 'click', target }, { kind: 'type', text: 'mixed' }],
    [{ kind: 'click', target, element: 'e1' }], [{ kind: 'verify', target, value: 'Bearer 123456789abc' }],
    [{ kind: 'verify', target, value: 'Hello', extra: true }], [{ kind: 'type', target, text: 'Hello\nUnexpected' }],
    [{ kind: 'key', target, key: 'Escape' }], [{ kind: 'click', target: { ...target, name: '' } }],
  ]) await expect(tool.run({ snapshot: 'fresh', actions: bad }, { task: '' })).rejects.toThrow()
  expect(sequence).not.toHaveBeenCalled()
})

it('permits line breaks in read-only verification but never in dispatched typing', async () => {
  const sequence = vi.fn(async () => 'checked')
  const tool = desktopTools({ read: async () => '', sequence }).find((one) => one.name === 'desktop_sequence')!
  const target = { name: 'Draft', controlType: 'Edit' }
  const args = { snapshot: 'fresh', actions: [{ kind: 'verify', target, value: 'One\r\nTwo\tThree' }] }
  expect(await tool.run(args, { task: '' })).toBe('checked')
  sequence.mockClear()
  await expect(tool.run({ ...args, actions: [{ kind: 'verify', target, value: 'One\u0000Two' }] }, { task: '' })).rejects.toThrow()
  expect(sequence).not.toHaveBeenCalled()
})
