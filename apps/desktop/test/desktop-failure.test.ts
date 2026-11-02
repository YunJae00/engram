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

it('distinguishes unsent cancellation from uncertain dispatched work without retrying Stop', () => {
  expect(desktopFailure('The request expired or was cancelled before execution; it was not run')).toMatchObject({ delivery: 'not_delivered', retry: 'unsafe' })
  expect(desktopFailure('Stopped. It may have partly happened; read the app before retrying.')).toMatchObject({ delivery: 'delivery_uncertain', retry: 'unsafe' })
})

it('offers a targeted alternative when only one provider operation is unsupported', () => {
  expect(desktopFailure('This control does not support this background scroll action; choose a scrollable ancestor or request a deliberate foreground handover. No action was sent')).toMatchObject({ delivery: 'not_delivered', retry: 'unsafe', hint: expect.stringContaining('scrollable ancestor') })
})

it.each([
  ['Allow Engram in System Settings → Privacy & Security → Accessibility', 'accessibility_denied'],
  ['Allow Engram in System Settings → Privacy & Security → Screen Recording', 'screen_recording_denied'],
  ['Allow input monitoring and accessibility before computer control', 'input_monitoring_denied'],
  ['The computer connection closed. Allow input monitoring and accessibility before computer control', 'input_monitoring_denied'],
])('blocks permission retries with a distinct code: %s', (reason, error) => {
  expect(desktopFailure(reason)).toMatchObject({ error, retry: 'blocked', delivery: 'not_delivered', reason })
  expect(recoverablePreparation(reason)).toBe(false)
})
it('preserves bounded original diagnostics including window choices', () => {
  const reason = 'No open window matches Claude. Open windows: Notes, Claude Desktop'
  expect(desktopFailure(reason).reason).toBe(reason)
  expect(desktopFailure('x'.repeat(500)).reason).toHaveLength(300)
})
it('recognizes macOS protected windows and transient preparation', () => {
  expect(desktopFailure('This window is unavailable or requires manual control').error).toBe('policy_denied')
  expect(recoverablePreparation('Release the keyboard modifiers')).toBe(true)
  expect(recoverablePreparation('The selected window is no longer in front')).toBe(true)
})
it('reports a blocked local read without suggesting a web substitute', () => {
  expect(desktopFailure('Allow Engram in System Settings → Privacy & Security → Screen Recording').hint).toContain('Do not replace a local app read with web search')
})
