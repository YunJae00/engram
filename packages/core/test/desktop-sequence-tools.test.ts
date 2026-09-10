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

it('accepts explicit starting anchors and rejects malformed anchors before dispatch', async () => {
  const sequence = vi.fn(async () => 'checked')
  const tool = desktopTools({ read: async () => '', sequence }).find((one) => one.name === 'desktop_sequence')!
  const target = { name: 'Draft', controlType: 'Edit', element: 'e12' }
  expect(await tool.run({ snapshot: 'fresh', actions: [{ kind: 'type', target, text: 'Hello' }] }, { task: '' })).toBe('checked')
  expect(sequence).toHaveBeenCalledWith([{ kind: 'type', snapshot: 'fresh', target, text: 'Hello' }], { task: '' })
  sequence.mockClear()
  for (const element of ['', 'e-1', 'e123456789', 'Draft', 12, undefined]) {
    await expect(tool.run({ snapshot: 'fresh', actions: [{ kind: 'type', target: { ...target, element }, text: 'Hello' }] }, { task: '' })).rejects.toThrow()
  }
  expect(sequence).not.toHaveBeenCalled()
})

it('permits unnamed controls only with an explicit starting anchor', async () => {
  const sequence = vi.fn(async () => 'checked')
  const tool = desktopTools({ read: async () => '', sequence }).find((one) => one.name === 'desktop_sequence')!
  const target = { name: '', controlType: 'Document', element: 'e12' }
  const actions = [{ kind: 'type', target, text: 'Draft' }, { kind: 'verify', target, value: 'Draft' }]
  expect(await tool.run({ snapshot: 'fresh', actions }, { task: '' })).toBe('checked')
  expect(sequence).toHaveBeenCalledWith(actions.map((action) => ({ ...action, snapshot: 'fresh' })), { task: '' })
  sequence.mockClear()
  for (const invalid of [{ name: '', controlType: 'Document' }, { ...target, element: undefined }, { ...target, element: 'Document' }]) {
    await expect(tool.run({ snapshot: 'fresh', actions: [{ kind: 'type', target: invalid, text: 'Draft' }] }, { task: '' })).rejects.toThrow()
  }
  expect(sequence).not.toHaveBeenCalled()
})

it('validates explicit whole-field replacements and redacts both old and new content', async () => {
  const act = vi.fn(async () => 'read the new value'), sequence = vi.fn(async () => 'checked')
  const tools = desktopTools({ read: async () => '', act, sequence })
  const one = tools.find((tool) => tool.name === 'desktop_action')!
  const batch = tools.find((tool) => tool.name === 'desktop_sequence')!
  const args = { kind: 'replace', snapshot: 'fresh', element: 'e1', expected: 'Old draft', text: 'New draft' }
  expect(await one.run(args, { task: 'Replace the draft' })).toBe('read the new value')
  expect(act).toHaveBeenCalledWith(args, { task: 'Replace the draft' })
  expect(desktopStepArgs('desktop_action', args)).toEqual({ ...args, expected: '[redacted]', text: '[redacted]' })
  const target = { name: 'Draft', controlType: 'Edit', element: 'e1' }
  expect(await batch.run({ snapshot: 'fresh', actions: [{ kind: 'replace', target, expected: '', text: 'Draft' }] }, { task: '' })).toBe('checked')
  act.mockClear(); sequence.mockClear()
  for (const invalid of [{ ...args, expected: undefined }, { ...args, expected: 'Bearer 123456789abc' }, { ...args, text: 'Bearer 123456789abc' },
    { ...args, expected: 'x'.repeat(2001) }, { ...args, expected: 'bad\0value' }, { ...args, text: '' }, { ...args, text: 'New\nDraft' }])
    await expect(one.run(invalid, { task: '' })).rejects.toThrow()
  await expect(batch.run({ snapshot: 'fresh', actions: [{ kind: 'replace', element: 'e1', expected: '', text: 'Draft' }] }, { task: '' })).rejects.toThrow('guarded targets')
  expect(act).not.toHaveBeenCalled()
  expect(sequence).not.toHaveBeenCalled()
})
