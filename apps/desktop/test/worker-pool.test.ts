import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CpuInfo } from 'node:os'
const execFileSpy = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (load) => ({ ...(await load<typeof import('node:child_process')>()), execFile: execFileSpy }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { asBackground, whileWaitingForPerson, withLease, cpuBusyFromTimes, idleBeyond, insideSlot, nextTarget, parseMacSysctl, sampler, waitLine, withTurnPriority, workerBase, WorkerPool, type Sample } from '../src/main/worker-pool.js'
import { SessionPool, type SessionSdk } from '../src/main/engine-claude-session.js'
import type { EngineCwd, ToolSessionJob } from 'core'

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

describe('leases', () => {
  it('nested turns at target 1 borrow the parent\'s slot one at a time and never wait on the parent', async () => {
    const { p } = pool(1)
    const parent = await p.lease()
    let active = 0, peak = 0
    const helper = () => withLease(parent!, () => insideSlot(async () => {
      const lease = await p.lease()
      active++; peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active--; lease?.end()
    }))
    const done = Promise.all([helper(), helper(), helper()])
    await vi.advanceTimersByTimeAsync(100)
    await done
    expect(peak).toBe(1)
    expect(p.running).toBe(1)
    parent!.end()
    expect(p.running).toBe(0)
  })

  it('a nested turn takes a free slot when one is open, else borrows the parent\'s, never past the target', async () => {
    const { p } = pool(2)
    const parent = await p.lease()
    const a = await withLease(parent!, () => insideSlot(() => p.lease()))
    expect(p.running).toBe(2)
    const b = await withLease(parent!, () => insideSlot(() => p.lease()))
    expect(p.running).toBe(2)
    let third = false
    const c = withLease(parent!, () => insideSlot(() => p.lease())).then(l => { third = true; return l })
    await flush()
    expect(third).toBe(false)
    b!.end(); await flush()
    expect(third).toBe(true)
    expect(p.running).toBe(2)
    ;(await c)!.end(); a!.end(); parent!.end()
    expect(p.running).toBe(0)
  })

  it('a turn waiting for the person lends its slot and takes it back after the answer', async () => {
    const { p } = pool(1)
    const parent = await p.lease()
    let answer!: (v: string) => void
    const asked = withLease(parent!, () => whileWaitingForPerson(() => new Promise<string>(resolve => { answer = resolve })))
    await flush()
    expect(p.running).toBe(0)
    const chat = track(withTurnPriority({ interactive: true }, () => p.acquire()))
    await flush()
    expect(chat.settled).toBe(true)
    answer('approve')
    await flush()
    let back = false
    void asked.then(() => { back = true })
    await flush()
    expect(back).toBe(false)
    chat.release?.()
    await flush()
    expect(back).toBe(true)
    expect(await asked).toBe('approve')
    expect(p.running).toBe(1)
    parent!.end()
    expect(p.running).toBe(0)
  })

  it('a turn stopped while waiting to take its slot back holds nothing', async () => {
    const { p } = pool(1)
    const abort = new AbortController()
    const parent = await p.lease(abort.signal)
    const other = track(Promise.resolve(null))
    let answer!: () => void
    const asked = withLease(parent!, () => whileWaitingForPerson(() => new Promise<void>(resolve => { answer = resolve })))
    await flush()
    const busy = await p.acquire()
    answer(); await flush()
    abort.abort(); await flush()
    await asked
    parent!.end()
    busy?.()
    expect(p.running).toBe(0)
    expect(other.settled).toBe(true)
  })
})

describe('borrowed leases', () => {
  it('a borrowed child waiting for the person lends the slot at target 1 and gets it back after the answer', async () => {
    const { p } = pool(1)
    const parent = await p.lease()
    const child = await withLease(parent!, () => insideSlot(() => p.lease()))
    expect(p.running).toBe(1)
    let answer!: () => void
    let resumed = false
    const asked = withLease(child!, () => whileWaitingForPerson(() => new Promise<void>(resolve => { answer = resolve }))).then(() => { resumed = true })
    await flush()
    expect(p.running).toBe(0)
    const chat = track(withTurnPriority({ interactive: true }, () => p.acquire()))
    await flush()
    expect(chat.settled).toBe(true)
    answer(); await flush()
    expect(resumed).toBe(false)
    chat.release?.(); await flush()
    await asked
    expect(resumed).toBe(true)
    expect(p.running).toBe(1)
    child!.end(); parent!.end()
    expect(p.running).toBe(0)
  })

  it('ending a parent while its borrowed child runs keeps the slot until the child ends', async () => {
    const { p } = pool(1)
    const parent = await p.lease()
    const child = await withLease(parent!, () => insideSlot(() => p.lease()))
    parent!.end()
    expect(p.running).toBe(1)
    const next = track(p.acquire())
    await flush()
    expect(next.settled).toBe(false)
    child!.end(); await flush()
    expect(next.settled).toBe(true)
    next.release?.()
    expect(p.running).toBe(0)
  })

  it('a grandchild waiting for the person also lends the slot', async () => {
    const { p } = pool(1)
    const parent = await p.lease()
    const child = await withLease(parent!, () => insideSlot(() => p.lease()))
    const grandchild = await withLease(child!, () => insideSlot(() => p.lease()))
    let answer!: () => void
    const asked = withLease(grandchild!, () => whileWaitingForPerson(() => new Promise<void>(resolve => { answer = resolve })))
    await flush()
    expect(p.running).toBe(0)
    answer(); await asked
    expect(p.running).toBe(1)
    grandchild!.end(); child!.end(); parent!.end()
    expect(p.running).toBe(0)
  })
})

describe('leases through a warm session', () => {
  // A stand-in runtime whose tool pump lives as long as the session, like the real one.
  const sdk: SessionSdk = {
    createSdkMcpServer: (options) => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt, options }) => {
      const server = (options?.['mcpServers'] as Record<string, { tools: { handler(args: unknown): Promise<{ content: { text: string }[] }> }[] }>)['engram']!
      async function* run(): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        for await (const message of prompt) {
          void message
          const said = await server.tools[0]!.handler({})
          yield { type: 'assistant', message: { content: [{ type: 'text', text: said.content[0]!.text }] } }
          yield { type: 'result', subtype: 'success', result: said.content[0]!.text }
        }
      }
      return Object.assign(run(), { interrupt: async () => undefined }) as never
    },
  }

  it('each turn of a reused session lends its own slot to nested turns and approval waits, at target 1', async () => {
    vi.useRealTimers()
    const { p } = pool(1)
    const sessions = new SessionPool()
    const seen: string[] = []
    const job = (name: string): ToolSessionJob => ({
      workdir: '/tmp' as EngineCwd, system: 'rules', prompt: name, maxCalls: 4, sessionKey: 'chat',
      tools: [{ name: 'helper', description: 'helper', argsSchema: { type: 'object', properties: {} }, run: async () => {
        const nested = await p.lease()
        seen.push(`${name} nested running=${p.running}`)
        nested?.end()
        await whileWaitingForPerson(async () => { seen.push(`${name} waiting running=${p.running}`) })
        return 'ok'
      } }],
    })
    const spec = { sdk, binary: 'claude', workdir: '/tmp', model: 'fixture' }
    try {
      for (const name of ['first', 'second']) {
        const lease = await p.lease()
        const result = await Promise.race([withLease(lease!, () => sessions.run(job(name), spec)), new Promise(resolve => setTimeout(() => resolve('stuck'), 2000))])
        expect(result).not.toBe('stuck')
        lease!.end()
        expect(p.running).toBe(0)
      }
      expect(seen).toEqual(['first nested running=1', 'first waiting running=0', 'second nested running=1', 'second waiting running=0'])
    } finally { sessions.closeAll(); vi.useFakeTimers() }
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
