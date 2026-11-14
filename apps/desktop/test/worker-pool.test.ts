import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CpuInfo } from 'node:os'
const execFileSpy = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (load) => ({ ...(await load<typeof import('node:child_process')>()), execFile: execFileSpy }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { asBackground, cpuBusyFromTimes, idleBeyond, insideSlot, nextTarget, parseMacSysctl, sampler, waitLine, withTurnPriority, workerBase, WorkerPool, type Sample } from '../src/main/worker-pool.js'
import { SessionPool } from '../src/main/engine-claude-session.js'

const GB = 2 ** 30
const MB = 2 ** 20
const healthy: Sample = { freePct: 60, swapGrowthBytes: 0, cpuBusyPct: 10 }
const lowFree: Sample = { freePct: 20, swapGrowthBytes: 0, cpuBusyPct: 10 }
const flush = () => vi.advanceTimersByTimeAsync(0)

function pool(base: number, samples: Sample[] = []) {
  const queue = [...samples]
  const sample = vi.fn(async () => queue.shift() ?? { freePct: 30, swapGrowthBytes: 0, cpuBusyPct: 50 })
  const log = vi.fn()
  const p = new WorkerPool({ base, sample, intervalMs: 5000, log })
  return { p, sample, log, queue }
}

function track(promise: Promise<(() => void) | null>) {
  const state: { release?: (() => void) | null; settled: boolean } = { settled: false }
  void promise.then(r => { state.release = r; state.settled = true })
  return state
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('workerBase', () => {
  it('follows RAM and cores, clamped to 1..8', () => {
    expect(workerBase(8 * GB, 8)).toBe(5)
    expect(workerBase(16 * GB, 10)).toBe(8)
    expect(workerBase(4 * GB, 4)).toBe(2)
    expect(workerBase(2 * GB, 2)).toBe(1)
  })
})

describe('nextTarget', () => {
  it('shrinks on low free memory, swap growth or busy CPU, never below 1', () => {
    expect(nextTarget({ target: 3, healthy: 1 }, 5, lowFree)).toEqual({ target: 2, healthy: 0 })
    expect(nextTarget({ target: 3, healthy: 0 }, 5, { ...healthy, swapGrowthBytes: 65 * MB })).toEqual({ target: 2, healthy: 0 })
    expect(nextTarget({ target: 3, healthy: 0 }, 5, { ...healthy, cpuBusyPct: 95 })).toEqual({ target: 2, healthy: 0 })
    expect(nextTarget({ target: 1, healthy: 0 }, 5, lowFree)).toEqual({ target: 1, healthy: 0 })
  })
  it('grows only after two healthy samples in a row and never above base', () => {
    let s = { target: 2, healthy: 0 }
    s = nextTarget(s, 3, healthy)
    expect(s.target).toBe(2)
    s = nextTarget(s, 3, { freePct: 30, swapGrowthBytes: 0, cpuBusyPct: 10 })
    s = nextTarget(s, 3, healthy)
    expect(s.target).toBe(2)
    s = nextTarget(s, 3, healthy)
    expect(s.target).toBe(3)
    s = nextTarget(nextTarget(s, 3, healthy), 3, healthy)
    expect(s.target).toBe(3)
  })
})

describe('sampler', () => {
  const platform = process.platform
  afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }) })
  const cpu = (busy: number, idle: number): CpuInfo => ({ model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, irq: 0, idle } })

  it('on Windows uses freemem and cpu time deltas and never shells out', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const readings = [[cpu(100, 100), cpu(100, 100)], [cpu(180, 120), cpu(180, 120)]]
    const sysctl = vi.fn(async () => '')
    const fakeOs = { freemem: () => 3 * GB, totalmem: () => 12 * GB, loadavg: () => [9, 9, 9], cpus: () => readings.shift() ?? [] }
    const read = sampler({ os: fakeOs, sysctl })
    expect(await read()).toEqual({ freePct: 25, swapGrowthBytes: 0, cpuBusyPct: 0 })
    expect((await read()).cpuBusyPct).toBeCloseTo(80)
    expect(sysctl).not.toHaveBeenCalled()
    expect(execFileSpy).not.toHaveBeenCalled()
  })
  it('on macOS reads memorystatus level and swap growth, falling back when sysctl fails', async () => {
    const outs = ['50\ntotal = 2048.00M  used = 100.00M  free = 1948.00M\n', '45\ntotal = 2048.00M  used = 200.00M  free = 1848.00M\n']
    const sysctl = vi.fn(async () => { const out = outs.shift(); if (!out) throw new Error('gone'); return out })
    const fakeOs = { freemem: () => 1 * GB, totalmem: () => 10 * GB, loadavg: () => [2, 2, 2], cpus: () => [cpu(0, 0), cpu(0, 0), cpu(0, 0), cpu(0, 0)] }
    const read = sampler({ platform: 'darwin', os: fakeOs, sysctl, cacheMs: 0 })
    expect(await read()).toEqual({ freePct: 50, swapGrowthBytes: 0, cpuBusyPct: 50 })
    expect(await read()).toEqual({ freePct: 45, swapGrowthBytes: 100 * MB, cpuBusyPct: 50 })
    expect(await read()).toEqual({ freePct: 10, swapGrowthBytes: 0, cpuBusyPct: 50 })
    expect(parseMacSysctl('x\nnothing')).toEqual({})
  })
  it('on macOS reuses a reading younger than the cache window, so back-to-back acquires spawn one sysctl', async () => {
    let t = 0
    const sysctl = vi.fn(async () => '50\ntotal = 2048.00M  used = 100.00M  free = 1948.00M\n')
    const fakeOs = { freemem: () => 1 * GB, totalmem: () => 10 * GB, loadavg: () => [0, 0, 0], cpus: () => [cpu(0, 0)] }
    const read = sampler({ platform: 'darwin', os: fakeOs, sysctl, now: () => t })
    await read(); await read(); t = 999; await read()
    expect(sysctl).toHaveBeenCalledTimes(1)
    t = 1000; await read()
    expect(sysctl).toHaveBeenCalledTimes(2)
    const p = new WorkerPool({ base: 4, sample: read, log: vi.fn() })
    t = 5000
    const releases = await Promise.all([p.acquire(), p.acquire(), p.acquire()])
    expect(sysctl).toHaveBeenCalledTimes(3)
    for (const r of releases) r?.()
    p.stop()
  })
  it('computes busy percent from cpu times', () => {
    expect(cpuBusyFromTimes([cpu(0, 0)], [cpu(50, 50)])).toBe(50)
    expect(cpuBusyFromTimes([cpu(0, 0)], [])).toBe(0)
  })
})

describe('WorkerPool', () => {
  it('re-reads the target at each acquire before granting', async () => {
    const { p, sample } = pool(3, [lowFree, lowFree])
    const a = track(p.acquire())
    await flush()
    expect(sample).toHaveBeenCalledTimes(1)
    expect(p.target).toBe(2)
    const b = track(p.acquire())
    const c = track(p.acquire())
    await flush()
    expect(p.target).toBe(1)
    expect([a.settled, b.settled, c.settled]).toEqual([true, false, false])
  })

  it('grants background turns in FIFO order', async () => {
    const { p } = pool(1)
    const a = track(p.acquire())
    await flush()
    const order: string[] = []
    for (const name of ['B', 'C', 'D']) void p.acquire().then(r => { order.push(name); setTimeout(() => r?.(), 10) })
    await flush()
    a.release?.()
    await vi.advanceTimersByTimeAsync(100)
    expect(order).toEqual(['B', 'C', 'D'])
  })

  it('a chore started from a person\'s turn waits behind queued background turns', async () => {
    const { p } = pool(1)
    const a = track(p.acquire())
    await flush()
    const order: string[] = []
    const take = (name: string) => (r: (() => void) | null) => { order.push(name); setTimeout(() => r?.(), 10) }
    void p.acquire().then(take('queued'))
    await flush()
    void withTurnPriority({ interactive: true }, () => asBackground(() => p.acquire())).then(take('title'))
    await flush()
    a.release?.()
    await vi.advanceTimersByTimeAsync(100)
    expect(order).toEqual(['queued', 'title'])
  })

  it('tells listeners when the target changes, so the idle cap follows at once', async () => {
    const { p } = pool(3, [lowFree])
    const seen: number[] = []
    p.onTarget(target => seen.push(target))
    await p.sampleNow()
    expect(seen).toEqual([2])
    await p.sampleNow()
    expect(seen).toEqual([2])
  })

  it('lets an interactive turn go ahead of background turns', async () => {
    const { p } = pool(1)
    const a = track(p.acquire())
    await flush()
    const order: string[] = []
    const take = (name: string) => (r: (() => void) | null) => { order.push(name); setTimeout(() => r?.(), 10) }
    void p.acquire().then(take('B'))
    void p.acquire().then(take('C'))
    void withTurnPriority({ interactive: true }, () => p.acquire()).then(take('D'))
    await flush()
    a.release?.()
    await vi.advanceTimersByTimeAsync(100)
    expect(order).toEqual(['D', 'B', 'C'])
  })

  it('drops a waiter aborted while queued without running it', async () => {
    const { p } = pool(1)
    const a = track(p.acquire())
    await flush()
    const say = vi.fn()
    const abort = new AbortController()
    const b = track(withTurnPriority({ interactive: true, say }, () => p.acquire(abort.signal)))
    await flush()
    abort.abort()
    await flush()
    expect(b).toEqual({ settled: true, release: null })
    expect(p.queued).toBe(0)
    await vi.advanceTimersByTimeAsync(3000)
    expect(say).not.toHaveBeenCalled()
    a.release?.()
    expect(p.running).toBe(0)
  })

  it('releases the slot when a turn fails or is aborted after the grant', async () => {
    const { p } = pool(1)
    const run = (signal?: AbortSignal) => p.acquire(signal).then(release => Promise.reject(new Error('boom')).finally(() => release?.()))
    await expect(run()).rejects.toThrow('boom')
    expect(p.running).toBe(0)
    const abort = new AbortController()
    const turn = p.acquire(abort.signal).then(release => new Promise<void>(resolve => abort.signal.addEventListener('abort', () => { release?.(); resolve() })))
    await flush()
    expect(p.running).toBe(1)
    abort.abort()
    await turn
    expect(p.running).toBe(0)
    const next = track(p.acquire())
    await flush()
    expect(next.settled).toBe(true)
  })

  it('a double release does not free extra capacity', async () => {
    const { p } = pool(1)
    const a = track(p.acquire())
    await flush()
    a.release?.()
    a.release?.()
    expect(p.running).toBe(0)
  })

  it('a shrinking target never aborts running turns; new turns wait', async () => {
    const { p, queue } = pool(3, [healthy, healthy, healthy])
    const turns = [track(p.acquire()), track(p.acquire()), track(p.acquire())]
    await flush()
    expect(p.running).toBe(3)
    queue.splice(0, queue.length, lowFree, lowFree)
    await p.sampleNow()
    await p.sampleNow()
    expect(p.target).toBe(1)
    const waiting = track(p.acquire())
    await flush()
    expect(p.target).toBe(1)
    expect(p.running).toBe(3)
    turns[0]!.release?.()
    turns[1]!.release?.()
    await flush()
    expect(waiting.settled).toBe(false)
    turns[2]!.release?.()
    await flush()
    expect(waiting.settled).toBe(true)
  })

  it('a turn started from inside a slot takes no slot of its own', async () => {
    const { p } = pool(1)
    track(p.acquire())
    await flush()
    const nested = track(insideSlot(() => p.acquire()))
    await flush()
    expect(nested.settled).toBe(true)
    expect(p.running).toBe(1)
  })

  it('a waiting interactive turn says once after 2 s, in the thread language', async () => {
    for (const korean of [true, false]) {
      const { p } = pool(1)
      const a = track(p.acquire())
      await flush()
      const say = vi.fn()
      void withTurnPriority({ interactive: true, korean, say }, () => p.acquire())
      await vi.advanceTimersByTimeAsync(1999)
      expect(say).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(say).toHaveBeenCalledTimes(1)
      expect(say).toHaveBeenCalledWith(waitLine(korean))
      await vi.advanceTimersByTimeAsync(5000)
      expect(say).toHaveBeenCalledTimes(1)
      a.release?.()
      p.stop()
    }
    expect(waitLine(true)).toBe('앞 작업 끝나면 바로 할게')
    const { p } = pool(1)
    const say = vi.fn()
    void withTurnPriority({ interactive: true, say }, () => p.acquire())
    await vi.advanceTimersByTimeAsync(3000)
    expect(say).not.toHaveBeenCalled()
  })
})

describe('idle warm-session cap', () => {
  it('idleBeyond picks the least recently used idle sessions only', () => {
    const rows = [{ key: 'a', busy: false, lastUsed: 1 }, { key: 'b', busy: true, lastUsed: 0 }, { key: 'c', busy: false, lastUsed: 3 }, { key: 'd', busy: false, lastUsed: 2 }]
    expect(idleBeyond(rows, 1)).toEqual(['a', 'd'])
    expect(idleBeyond(rows, 5)).toEqual([])
  })

  it('SessionPool.trim counts the spare and never closes a busy session', () => {
    const sessions = new SessionPool()
    const fake = (busy: boolean, lastUsed: number) => ({ busy, lastUsed, close: vi.fn() })
    const old = fake(false, 1)
    const busy = fake(true, 0)
    const recent = fake(false, 5)
    const spare = fake(false, 3)
    const inner = sessions as unknown as { sessions: Map<string, unknown>; spare: unknown }
    inner.sessions.set('p:old', old).set('p:busy', busy).set('p:recent', recent)
    inner.spare = { session: spare, cwd: '/tmp/x' }
    sessions.trim(1)
    expect(old.close).toHaveBeenCalled()
    expect(spare.close).toHaveBeenCalled()
    expect(busy.close).not.toHaveBeenCalled()
    expect(recent.close).not.toHaveBeenCalled()
    expect([...inner.sessions.keys()]).toEqual(['p:busy', 'p:recent'])
    expect(inner.spare).toBeNull()
  })
})
