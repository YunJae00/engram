import { beforeEach, expect, it, vi } from 'vitest'
import type { DesktopObservationDto } from '../src/shared/desktop.js'
const fake = vi.hoisted(() => ({ read: vi.fn(), act: vi.fn(), original: vi.fn() }))
vi.mock('../src/main/desktop-control.js', () => ({ readControlledDesktop: fake.read, actOnDesktop: fake.act, desktopObservation: fake.original }))
import { desktopSequence } from '../src/main/desktop-sequence.js'
function view(snapshot = 'first', id = 'e1'): DesktopObservationDto {
  return { snapshot, truncated: false, bounds: { x: 0, y: 0, width: 400, height: 500 }, nodes: [{ id, name: 'One', controlType: 'Button', bounds: { x: 10, y: 20, width: 40, height: 30 } }] }
}
beforeEach(() => {
  vi.clearAllMocks()
  fake.original.mockReturnValue(view())
  fake.read.mockResolvedValue(view('fresh', 'e9'))
  fake.act.mockResolvedValue('dispatched')
})
it('resolves fresh element IDs and observes every action within one call', async () => {
  const result = JSON.parse(await desktopSequence('bot-test', [
    { kind: 'click', snapshot: 'first', element: 'e1' }, { kind: 'click', snapshot: 'first', element: 'e1' },
  ]))
  expect(result.completed).toBe(2)
  expect(result.observation.snapshot).toBe('fresh')
  expect(fake.read).toHaveBeenCalledTimes(3)
  expect(fake.act).toHaveBeenCalledWith('bot-test', { kind: 'click', snapshot: 'fresh', element: 'e9' }, undefined)
})
it('stops before the next input if a dialog or layout appears', async () => {
  const changed = view('dialog')
  changed.nodes.push({ ...changed.nodes[0]!, id: 'e2', name: 'Confirm' })
  fake.read.mockResolvedValueOnce(view('fresh')).mockResolvedValue(changed)
  const result = JSON.parse(await desktopSequence('bot-test', [
    { kind: 'click', snapshot: 'first', element: 'e1' }, { kind: 'key', snapshot: 'first', key: 'Enter' },
  ]))
  expect(result.completed).toBe(1)
  expect(result.error).toContain('interface changed')
  expect(fake.act).toHaveBeenCalledOnce()
})
it('reports the first error without retrying or proceeding', async () => {
  fake.act.mockRejectedValueOnce(new Error('Original native failure'))
  const result = JSON.parse(await desktopSequence('bot-test', [
    { kind: 'click', snapshot: 'first', element: 'e1' }, { kind: 'type', snapshot: 'first', text: 'Example' },
  ]))
  expect(result.error).toBe('Original native failure')
  expect(result.completed).toBe(0)
  expect(fake.act).toHaveBeenCalledOnce()
})
it('does not inject after cancellation or an incomplete observation', async () => {
  await expect(desktopSequence('bot-test', [{ kind: 'key', snapshot: 'first', key: 'Tab' }], AbortSignal.abort())).rejects.toThrow()
  fake.original.mockReturnValue({ ...view(), truncated: true })
  await expect(desktopSequence('bot-test', [{ kind: 'key', snapshot: 'first', key: 'Tab' }])).rejects.toThrow('complete observation')
  expect(fake.act).not.toHaveBeenCalled()
})

function editorView(snapshot = 'first'): DesktopObservationDto {
  return { ...view(snapshot), truncated: true, captureSafe: true, focusedEditable: true, focusedControl: 'editor-1',
    nodes: [{ id: 'e1', runtimeId: 'editor-1', name: 'Draft', controlType: 'Edit', actions: { type: true }, bounds: { x: 10, y: 20, width: 300, height: 100 } }] }
}
const edits = [
  { kind: 'click', snapshot: 'first', element: 'e1' },
  { kind: 'key', snapshot: 'first', key: 'Control+A' },
  { kind: 'type', snapshot: 'first', text: 'Updated draft' },
] as const
it('edits an anchored field in a large partial view without additional model calls', async () => {
  fake.original.mockReturnValue(editorView())
  fake.read.mockResolvedValue(editorView('fresh'))
  const result = JSON.parse(await desktopSequence('bot-test', [...edits]))
  expect(result.completed).toBe(3)
  expect(result.error).toBeUndefined()
  expect(result.requiresVerification).toBe(true)
  expect(fake.act).toHaveBeenCalledTimes(3)
  expect(fake.read).toHaveBeenCalledTimes(4)
})
it.each(['focus', 'runtime', 'bounds', 'password'] as const)('stops focused editing on a changed %s', async (change) => {
  fake.original.mockReturnValue(editorView())
  const changed = editorView('changed')
  if (change === 'focus') changed.focusedControl = 'another-editor'
  if (change === 'runtime') changed.nodes[0]!.runtimeId = 'replacement'
  if (change === 'bounds') changed.bounds.width++
  if (change === 'password') changed.captureSafe = false
  fake.read.mockResolvedValueOnce(editorView('ready')).mockResolvedValue(changed)
  const result = JSON.parse(await desktopSequence('bot-test', [...edits]))
  expect(result.error).toBeTruthy()
  expect(result.dispatched).toBe(1)
  expect(fake.act).toHaveBeenCalledOnce()
})
it.each(['Tab', 'Enter', 'Control+F'])('does not batch %s across a partial interface', async (key) => {
  fake.original.mockReturnValue(editorView())
  await expect(desktopSequence('bot-test', [edits[0], { kind: 'key', snapshot: 'first', key }])).rejects.toThrow('complete observation')
  expect(fake.act).not.toHaveBeenCalled()
})
it('does not report successful editing when the final readback loses the target', async () => {
  fake.original.mockReturnValue(editorView())
  const changed = editorView('last')
  changed.focusedControl = 'another-editor'
  fake.read.mockResolvedValueOnce(editorView()).mockResolvedValueOnce(editorView()).mockResolvedValueOnce(editorView()).mockResolvedValue(changed)
  const result = JSON.parse(await desktopSequence('bot-test', [...edits]))
  expect(result.dispatched).toBe(3)
  expect(result.completed).toBe(2)
  expect(result.error).toContain('focus changed')
  expect(result.observationMayBeStale).toBe(true)
})
