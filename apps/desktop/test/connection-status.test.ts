import { expect, it, vi } from 'vitest'
import { connectionConfirmed, connectionLabel } from '../src/renderer/src/lib/connectionStatus.js'
import { connectionProbe } from '../src/main/connection-probe.js'

it('distinguishes signed out, unknown, expired and quota-limited accounts', () => {
  const connected = { installed: true, loggedIn: true, conclusive: true }
  expect(connectionConfirmed(connected)).toBe(true)
  expect(connectionLabel(connected, 'codex')).toBe('Connected')
  expect(connectionLabel(undefined, 'codex')).toBe('Checking connection…')
  expect(connectionConfirmed({ ...connected, conclusive: false })).toBe(false)
  expect(connectionLabel({ ...connected, conclusive: false }, 'codex')).toBe('Connection not verified')
  expect(connectionLabel({ ...connected, loggedIn: false }, 'codex')).toBe('Not connected')
  expect(connectionLabel({ ...connected, healthy: false, healthReason: 'quota' }, 'codex')).toBe('Usage limit reached')
  expect(connectionConfirmed({ ...connected, healthy: false, healthReason: 'auth' })).toBe(false)
  expect(connectionLabel({ ...connected, healthy: false, healthReason: 'auth' }, 'codex')).toBe('Reconnect required')
  expect(connectionLabel({ ...connected, conclusive: false, healthy: false, healthReason: 'auth' }, 'codex')).toBe('Reconnect required')
  expect(connectionLabel({ ...connected, installed: false, healthy: false, healthReason: 'auth' }, 'claude')).toBe('Not installed')
})

it('ends a hung connection check as unknown, not signed out or connected', async () => {
  vi.useFakeTimers()
  try {
    const checking = connectionProbe(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await checking).toEqual({ installed: true, loggedIn: false, conclusive: false })
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('keeps provider evidence and handles probe failures without inventing a logout', async () => {
  expect(await connectionProbe(async () => ({ installed: true, loggedIn: true, conclusive: true }))).toEqual({ installed: true, loggedIn: true, conclusive: true })
  expect(await connectionProbe(async () => { throw new Error('runtime busy') })).toEqual({ installed: true, loggedIn: false, conclusive: false })
})
