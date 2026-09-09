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
