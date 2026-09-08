import { describe, expect, it, vi } from 'vitest'
import { DesktopControlLease } from '../src/desktop-control-lease.js'

const lane = 'bot-first'
const other = 'bot-second'

function setup(ttlMs = 1000) {
  let time = 10_000
  const onChange = vi.fn()
  const lease = new DesktopControlLease({ now: () => time, token: () => 'nonce', ttlMs, onChange })
  return { lease, onChange, advance: (milliseconds: number) => { time += milliseconds } }
}

function active(lease: DesktopControlLease, owner = lane): string {
  const token = lease.reserve(owner, 'Editor')
  lease.activate(token)
  return token
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('desktop control ownership', () => {
  it('starts idle and grants no action before explicit activation', () => {
    const { lease } = setup()
    expect(lease.state()).toEqual({ state: 'idle' })
    expect(lease.tokenFor(lane)).toBeNull()
    const token = lease.reserve(lane, 'Editor')
    expect(lease.state()).toEqual({ state: 'needs-person', lane, name: 'Editor', expiresAt: 11_000 })
    expect(lease.tokenFor(lane)).toBeNull()
    expect(() => lease.assertActive(token, lane)).toThrow('ended')
    lease.activate(token)
    expect(lease.state()).toMatchObject({ state: 'running', lane })
    expect(lease.tokenFor(lane)).toBe(token)
    expect(lease.tokenFor(other)).toBeNull()
    expect(() => lease.assertActive(token, other)).toThrow('another chat')
    expect(() => lease.assertActive('wrong', lane)).toThrow('ended')
    expect(() => lease.assertActive(token, lane)).not.toThrow()
  })

  it.each([false, true])('claims the global slot synchronously, active=%s', (running) => {
    const { lease } = setup()
    const token = lease.reserve(lane, 'Editor')
    if (running) lease.activate(token)
    for (const owner of [lane, other]) expect(() => lease.reserve(owner, 'Other app')).toThrow('pending or running')
    expect(lease.state().lane).toBe(lane)
  })

  it('rejects duplicate and unrelated activation without disrupting the owner', () => {
    const { lease } = setup()
    const token = lease.reserve(lane, 'Editor')
    expect(() => lease.activate('wrong')).toThrow('request ended')
    lease.activate(token)
    expect(() => lease.activate(token)).toThrow('already active')
    expect(lease.tokenFor(lane)).toBe(token)
  })

  it('revokes synchronously and cannot reactivate an old token after a new reservation', () => {
    const { lease } = setup()
    const token = active(lease)
    lease.stop('Physical input')
    expect(lease.tokenFor(lane)).toBeNull()
    expect(lease.state()).toEqual({ state: 'paused', lane, name: 'Editor', reason: 'Physical input' })
    const next = lease.reserve(other, 'Other app')
    expect(next).not.toBe(token)
    expect(() => lease.activate(token)).toThrow('request ended')
    expect(() => lease.assertActive(token, lane)).toThrow('ended')
    lease.activate(next)
    expect(lease.tokenFor(other)).toBe(next)
  })

  it('rejects a delayed approval after stop, including a pending request', () => {
    const { lease } = setup()
    const token = lease.reserve(lane, 'Editor')
    lease.stop('Cancelled')
    expect(() => lease.activate(token)).toThrow('request ended')
    expect(lease.state()).toMatchObject({ state: 'paused', reason: 'Cancelled' })
  })

  it('makes stop and reset idempotent and only reports actual changes', () => {
    const { lease, onChange } = setup()
    lease.stop()
    lease.reset()
    expect(onChange).not.toHaveBeenCalled()
    active(lease)
    expect(onChange).toHaveBeenCalledTimes(2)
    lease.stop('User stopped')
    lease.stop('Do not replace the original reason')
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(lease.state().reason).toBe('User stopped')
    lease.reset()
    lease.reset()
    expect(lease.state()).toEqual({ state: 'idle' })
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('reset invalidates a pending grant and permits a fresh owner', () => {
    const { lease } = setup()
    const token = lease.reserve(lane, 'Editor')
    lease.reset()
    const next = active(lease, other)
    expect(() => lease.activate(token)).toThrow('request ended')
    expect(lease.tokenFor(other)).toBe(next)
  })

  it('returns isolated state snapshots without exposing grant tokens', () => {
    const { lease } = setup()
    active(lease)
    const snapshot = lease.state()
    snapshot.state = 'idle'
    snapshot.lane = other
    snapshot.expiresAt = Infinity
    expect(lease.state()).toEqual({ state: 'running', lane, name: 'Editor', expiresAt: 11_000 })
    lease.stop('Stopped')
    const paused = lease.state()
    paused.reason = 'Modified'
    expect(lease.state().reason).toBe('Stopped')
    expect(Object.keys(lease.state())).not.toContain('token')
  })

  it.each(['', 'chat-first', 'bot-', `bot-${'a'.repeat(141)}`, 'bot-first\n'])('rejects invalid lane %j', (owner) => {
    const { lease, onChange } = setup()
    expect(() => lease.reserve(owner, 'Editor')).toThrow('valid chat')
    expect(lease.state()).toEqual({ state: 'idle' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each(['', '  ', 'x'.repeat(1025), 'Editor\0'])('rejects invalid window name %j', (name) => {
    const { lease } = setup()
    expect(() => lease.reserve(lane, name)).toThrow('window name')
    expect(lease.state().state).toBe('idle')
  })
})

describe('desktop control lifetime', () => {
  it('defaults to a ten-minute lifetime and refreshes it only at activation', () => {
    let now = 10
    const lease = new DesktopControlLease({ now: () => now })
    const token = lease.reserve(lane, 'Editor')
    expect(lease.state().expiresAt).toBe(600_010)
    now = 20
    lease.activate(token)
    expect(lease.state().expiresAt).toBe(600_020)
    now = 30
    lease.assertActive(token, lane)
    expect(lease.state().expiresAt).toBe(600_020)
  })

  it.each(['state', 'tokenFor', 'assertActive', 'activate', 'reserve', 'stop', 'reset', 'run'] as const)('checks expiration at %s', async (method) => {
    const { lease, advance } = setup()
    const token = active(lease)
    advance(1000)
    const work = vi.fn(async () => 'must not run')
    if (method === 'state') expect(lease.state().state).toBe('paused')
    else if (method === 'tokenFor') expect(lease.tokenFor(lane)).toBeNull()
    else if (method === 'assertActive') expect(() => lease.assertActive(token, lane)).toThrow('ended')
    else if (method === 'activate') expect(() => lease.activate(token)).toThrow('request ended')
    else if (method === 'reserve') lease.reserve(other, 'Other app')
    else if (method === 'stop') lease.stop('Late stop')
    else if (method === 'reset') lease.reset()
    else await expect(lease.run(token, lane, work)).rejects.toThrow('ended')
    expect(work).not.toHaveBeenCalled()
    expect(lease.tokenFor(lane)).toBeNull()
    expect(() => lease.activate(token)).toThrow('request ended')
    if (!['reserve', 'reset'].includes(method)) expect(lease.state().reason).toContain('expired')
  })

  it('expires pending consent without granting control from a late answer', () => {
    const { lease, advance } = setup()
    const token = lease.reserve(lane, 'Editor')
    advance(1000)
    expect(() => lease.activate(token)).toThrow('request ended')
    expect(lease.state().state).toBe('paused')
  })

  it.each([0, -1, NaN, Infinity])('rejects invalid lifetime %s', (ttlMs) => {
    expect(() => new DesktopControlLease({ ttlMs })).toThrow('positive and finite')
  })

  it('fails closed when the clock becomes unavailable', () => {
    let now = 100
    const lease = new DesktopControlLease({ now: () => now })
    const token = active(lease)
    now = NaN
    expect(() => lease.assertActive(token, lane)).toThrow('ended')
    expect(lease.state().state).toBe('paused')
    expect(() => lease.reserve(lane, 'Editor')).toThrow('lifetime')
  })
})

describe('desktop action dispatch', () => {
  it('runs one active action and returns its result', async () => {
    const { lease } = setup()
    const token = active(lease)
    await expect(lease.run(token, lane, async () => ({ done: true }))).resolves.toEqual({ done: true })
    await expect(lease.run(token, lane, async () => 'next')).resolves.toBe('next')
  })

  it('rejects parallel actions without queuing or revoking the accepted action', async () => {
    const { lease } = setup()
    const token = active(lease)
    const gate = deferred<string>()
    const first = lease.run(token, lane, () => gate.promise)
    const second = vi.fn(async () => 'second')
    await expect(lease.run(token, lane, second)).rejects.toThrow('still in progress')
    expect(second).not.toHaveBeenCalled()
    expect(lease.tokenFor(lane)).toBe(token)
    gate.resolve('first')
    await expect(first).resolves.toBe('first')
  })

  it.each(['stop', 'reset', 'expire'] as const)('rejects a late result after %s', async (action) => {
    const { lease, advance } = setup()
    const token = active(lease)
    const gate = deferred<string>()
    const result = lease.run(token, lane, () => gate.promise)
    const rejected = expect(result).rejects.toThrow('ended')
    if (action === 'expire') advance(1000)
    else lease[action]()
    gate.resolve('stale')
    await rejected
    expect(lease.tokenFor(lane)).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('never overlaps a newly granted session with old work that will %s', async (settlement) => {
    const { lease } = setup()
    const first = active(lease)
    const gate = deferred<string>()
    const result = lease.run(first, lane, () => gate.promise)
    const rejected = expect(result).rejects.toThrow(settlement === 'resolve' ? 'ended' : 'Old failure')
    lease.stop('User took over')
    const second = active(lease, other)
    const work = vi.fn(async () => 'new result')
    await expect(lease.run(second, other, work)).rejects.toThrow('still in progress')
    expect(work).not.toHaveBeenCalled()
    if (settlement === 'resolve') gate.resolve('old result')
    else gate.reject(new Error('Old failure'))
    await rejected
    expect(lease.tokenFor(other)).toBe(second)
    await expect(lease.run(second, other, work)).resolves.toBe('new result')
  })

  it.each([false, true])('revokes on native failure, synchronous=%s', async (synchronous) => {
    const { lease } = setup()
    const token = active(lease)
    const error = new Error('Native input failed')
    const work = () => { if (synchronous) throw error; return Promise.reject(error) }
    await expect(lease.run(token, lane, work)).rejects.toBe(error)
    expect(lease.state()).toMatchObject({ state: 'paused', lane })
    expect(lease.tokenFor(lane)).toBeNull()
    expect(() => lease.activate(token)).toThrow('request ended')
    const next = active(lease)
    await expect(lease.run(next, lane, async () => 'fresh')).resolves.toBe('fresh')
  })

  it('does not call native work with a stale token or the wrong lane', async () => {
    const { lease } = setup()
    const token = active(lease)
    const work = vi.fn(async () => 'never')
    await expect(lease.run(token, other, work)).rejects.toThrow('another chat')
    lease.stop()
    await expect(lease.run(token, lane, work)).rejects.toThrow('ended')
    expect(work).not.toHaveBeenCalled()
  })

  it('contains observer failures so revocation and action-slot cleanup still finish', async () => {
    const lease = new DesktopControlLease({ onChange: () => { throw new Error('Observer failed') } })
    const token = active(lease)
    await expect(lease.run(token, lane, async () => { throw new Error('Native failure') })).rejects.toThrow('Native failure')
    expect(lease.state().state).toBe('paused')
    const next = active(lease)
    await expect(lease.run(next, lane, async () => 'released')).resolves.toBe('released')
  })
})
