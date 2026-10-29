import { expect, it, vi } from 'vitest'
import { binding, control, lane } from './desktop-control-fixture.js'

it.each(['stop', 'end'])('keeps the helper when a %s acknowledgement times out', async action => {
  const held = binding()
  await control.ensureDesktopControl(lane)
  held.request.mockRejectedValueOnce(new DOMException('Stop acknowledgement timed out', 'TimeoutError'))
  if (action === 'stop') control.stopDesktopControl()
  else control.endDesktopTurn(lane)
  await vi.advanceTimersByTimeAsync(0)
  expect(held.request).toHaveBeenLastCalledWith('stop', expect.any(Object))
  expect(held.close).not.toHaveBeenCalled()
  expect(control.desktopControlStatus().state).not.toBe('running')
})

it('still closes a connection when Stop cannot be sent', async () => {
  const held = binding()
  await control.ensureDesktopControl(lane)
  held.request.mockRejectedValueOnce(new Error('Pipe closed'))
  control.stopDesktopControl()
  await vi.advanceTimersByTimeAsync(0)
  expect(held.close).toHaveBeenCalledOnce()
})
