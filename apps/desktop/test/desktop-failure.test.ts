import { expect, it } from 'vitest'
import { desktopFailure, recoverablePreparation } from '../src/main/desktop-failure.js'

it.each([
  ['This snapshot is stale.', 'stale_snapshot'],
  ['Unknown control ID for this snapshot', 'element_not_found'],
  ['The window identity is ambiguous. Observe it again', 'ambiguous'],
  ['Another surface covers the input position. Observe again', 'occluded'],
  ['Authentication, password, terminal, and security surfaces require manual control', 'policy_denied'],
])('classifies a rejected precondition: %s', (reason, error) => {
  expect(desktopFailure(reason)).toMatchObject({ error, delivery: 'not_delivered', retry: 'safe' })
})
it.each(['This app stopped responding', 'This control cannot be pressed', 'This control does not take text', 'Computer control stopped or user input changed'])('never retries uncertain delivery: %s', reason => {
  expect(desktopFailure(reason)).toMatchObject({ delivery: 'delivery_uncertain', retry: 'unsafe' })
})
it('keeps unverified delivery unsafe even when readback reports a stale snapshot', () => {
  expect(desktopFailure('This snapshot is stale.', { delivered: true, container: true })).toMatchObject({ delivery: 'delivered_unverified', retry: 'unsafe', hint: expect.stringContaining('inner actionable cell or button') })
})
it('limits transient recovery to preparation and preserves stop', () => {
  expect(recoverablePreparation('The pointer target changed')).toBe(true)
  expect(desktopFailure('The pointer target changed').retry).toBe('unsafe')
  expect(recoverablePreparation('Stopped by the user; window or desktop changed')).toBe(false)
})

it('preserves actionable guidance for provider routing and invalid arguments', () => {
  expect(desktopFailure('Fixture exposes its controls: use app_read')).toMatchObject({ error: 'policy_denied', retry: 'safe', hint: expect.stringContaining('app_read') })
  expect(desktopFailure('Invalid desktop action. Use one target.')).toMatchObject({ delivery: 'not_delivered', retry: 'safe', hint: expect.stringContaining('arguments') })
})
