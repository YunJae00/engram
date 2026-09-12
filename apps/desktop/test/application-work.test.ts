import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopControlStatusDto } from '../src/shared/desktop.js'
const fake = vi.hoisted(() => ({
  status: { state: 'idle' } as DesktopControlStatusDto,
  request: vi.fn(), close: vi.fn(), cancel: vi.fn(), prepare: vi.fn(), update: vi.fn(),
}))
vi.mock('electron', () => ({ screen: { screenToDipRect: (_: unknown, rect: unknown) => rect } }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: class { request = fake.request; close = fake.close } }))
vi.mock('../src/main/desktop-control.js', () => ({ cancelDesktopTurn: fake.cancel }))
vi.mock('../src/main/desktop-overlay.js', () => ({
  overlayStatus: () => fake.status,
  hideControlOverlay: () => { fake.status = { state: 'idle' } },
  prepareControlOverlay: async (status: DesktopControlStatusDto) => { fake.status = status; fake.prepare(status); return '1' },
  updateControlOverlay: (status: DesktopControlStatusDto) => { fake.status = status; fake.update(status) },
}))
import { applicationWork, clearApplicationWork, stopApplicationWork } from '../src/main/application-work.js'
const target = { window: '100', pid: 23, minimized: false, foreground: true, bounds: { x: 10, y: 20, width: 900, height: 600 } }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  fake.request.mockImplementation(async (method: string) => method === 'inputState' ? { escaped: false } : target)
})
afterEach(() => { clearApplicationWork(); vi.useRealTimers() })
it('uses the actual app window without acquiring input, follows geometry and stops the same lane', async () => {
  const work = applicationWork('one')
  await work.show('100', 'PowerPoint')
  expect(fake.status.application?.bounds).toEqual(target.bounds)
  expect(fake.status.inputActive).toBe(false)
  fake.request.mockResolvedValueOnce({ escaped: false }).mockResolvedValueOnce({ ...target, bounds: { ...target.bounds, x: 40 } })
  await vi.advanceTimersByTimeAsync(101)
  expect(fake.status.application?.bounds.x).toBe(40)
  expect(fake.request.mock.calls.every(([method]) => ['inputState', 'inspectWindow'].includes(method))).toBe(true)
  expect(stopApplicationWork()).toBe(true)
  expect(work.signal.aborted).toBe(true)
  expect(fake.cancel).toHaveBeenCalledWith('one', 'You stopped application work.')
  expect(fake.status.state).toBe('idle')
  expect(() => applicationWork('one')).toThrow()
})
it('treats Escape as a real stop and hides the overlay when the phase ends', async () => {
  const work = applicationWork('one')
  await work.show('100', 'Word')
  fake.request.mockResolvedValueOnce({ escaped: true })
  await vi.advanceTimersByTimeAsync(101)
  expect(work.signal.aborted).toBe(true)
  expect(fake.cancel).toHaveBeenCalledOnce()
  clearApplicationWork('other')
  expect(() => applicationWork('one')).toThrow()
  clearApplicationWork('one')
  expect(applicationWork('one').signal.aborted).toBe(false)
})

it('never overwrites another physical-control overlay', async () => {
  const work = applicationWork('one')
  await work.show('100', 'Word')
  fake.status = { state: 'running', lane: 'two', engine: 'claude' }
  await vi.advanceTimersByTimeAsync(101)
  expect(work.signal.aborted).toBe(true)
  expect(fake.status).toEqual({ state: 'running', lane: 'two', engine: 'claude' })
  expect(() => applicationWork('one')).toThrow('using the screen')
  fake.status = { state: 'idle' }
})
