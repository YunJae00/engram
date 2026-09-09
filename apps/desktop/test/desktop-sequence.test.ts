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
