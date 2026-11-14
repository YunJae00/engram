import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { flog } from './flog.js'

// How many Claude turns run at once, from the machine and its live load.

const MB = 1024 * 1024
export const WORKER_BYTES = 600 * MB
const MAX_BASE = 8

export function workerBase(totalBytes: number, cores: number): number {
  const memBase = Math.floor((totalBytes * 0.4) / WORKER_BYTES)
  const cpuBase = Math.max(1, cores - 1)
  return Math.min(MAX_BASE, Math.max(1, Math.min(memBase, cpuBase)))
}

export interface Sample { freePct: number; swapGrowthBytes: number; cpuBusyPct: number }
export interface TargetState { target: number; healthy: number }

export function nextTarget(state: TargetState, base: number, s: Sample): TargetState {
  const clamp = (n: number): number => Math.min(base, Math.max(1, n))
  if (s.freePct < 25 || s.swapGrowthBytes > 64 * MB || s.cpuBusyPct > 90) return { target: clamp(state.target - 1), healthy: 0 }
  if (s.freePct >= 40 && s.swapGrowthBytes <= 0 && s.cpuBusyPct < 70) {
    const healthy = state.healthy + 1
    if (healthy >= 2 && state.target < base) return { target: clamp(state.target + 1), healthy: 0 }
    return { target: clamp(state.target), healthy }
  }
  return { target: clamp(state.target), healthy: 0 }
}

export function cpuBusyFromTimes(prev: os.CpuInfo[], next: os.CpuInfo[]): number {
  if (prev.length !== next.length) return 0
  let total = 0
  let idle = 0
  next.forEach((cpu, i) => {
    const before = prev[i]!.times
    const t = cpu.times
    total += t.user + t.nice + t.sys + t.irq + t.idle - (before.user + before.nice + before.sys + before.irq + before.idle)
    idle += t.idle - before.idle
  })
  return total <= 0 ? 0 : 100 * (1 - idle / total)
}

export function parseMacSysctl(out: string): { freePct?: number; swapUsedBytes?: number } {
  const [level, swap] = out.split('\n')
  const parsed: { freePct?: number; swapUsedBytes?: number } = {}
  const pct = Number.parseInt(level?.trim() ?? '', 10)
  if (Number.isFinite(pct) && pct >= 0 && pct <= 100) parsed.freePct = pct
  const used = /used = ([\d.]+)([KMG])/.exec(swap ?? '')
  if (used) parsed.swapUsedBytes = Number(used[1]) * { K: 1024, M: MB, G: 1024 * MB }[used[2] as 'K' | 'M' | 'G']
  return parsed
}

export function idleBeyond(rows: { key: string; busy: boolean; lastUsed: number }[], cap: number): string[] {
  const idle = rows.filter(row => !row.busy).sort((a, b) => a.lastUsed - b.lastUsed)
  return idle.slice(0, Math.max(0, idle.length - cap)).map(row => row.key)
}

export const waitLine = (korean: boolean): string => (korean ? '앞 작업 끝나면 바로 할게' : 'Starting as soon as the current job finishes')

export interface SamplerDeps {
  platform?: NodeJS.Platform
  os?: Pick<typeof os, 'freemem' | 'totalmem' | 'loadavg' | 'cpus'>
  sysctl?: () => Promise<string>
  // A macOS reading younger than this is reused, so back-to-back acquires spawn no new sysctl.
  cacheMs?: number
  now?: () => number
}

const macSysctl = async (): Promise<string> => (await promisify(execFile)('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level', 'vm.swapusage'], { timeout: 1000 })).stdout

export function sampler(deps: SamplerDeps = {}): () => Promise<Sample> {
  const sys = deps.os ?? os
  const sysctl = deps.sysctl ?? macSysctl
  let prevSwap: number | undefined
  let prevCpus: os.CpuInfo[] | undefined
  const now = deps.now ?? Date.now
  const cacheMs = deps.cacheMs ?? 1000
  let cached: { at: number; sample: Sample } | undefined
  return async () => {
    const platform = deps.platform ?? process.platform
    const freePct = (sys.freemem() / sys.totalmem()) * 100
    const loadPct = (): number => (sys.loadavg()[0]! / Math.max(1, sys.cpus().length)) * 100
    if (platform === 'win32') {
      const cpus = sys.cpus()
      const cpuBusyPct = prevCpus ? cpuBusyFromTimes(prevCpus, cpus) : 0
      prevCpus = cpus
      return { freePct, swapGrowthBytes: 0, cpuBusyPct }
    }
    if (platform !== 'darwin') return { freePct, swapGrowthBytes: 0, cpuBusyPct: loadPct() }
    if (cached && now() - cached.at < cacheMs) return cached.sample
    const mac = await sysctl().then(parseMacSysctl, () => ({}) as ReturnType<typeof parseMacSysctl>)
    const swapGrowthBytes = mac.swapUsedBytes !== undefined && prevSwap !== undefined ? Math.max(0, mac.swapUsedBytes - prevSwap) : 0
    if (mac.swapUsedBytes !== undefined) prevSwap = mac.swapUsedBytes
    const sample = { freePct: mac.freePct ?? freePct, swapGrowthBytes, cpuBusyPct: loadPct() }
    cached = { at: now(), sample }
    return sample
  }
}

interface TurnScope { interactive: boolean; korean?: boolean; say?: (line: string) => void; inside?: boolean; lease?: Lease }
const scope = new AsyncLocalStorage<TurnScope>()
export function withTurnPriority<T>(value: Omit<TurnScope, 'inside' | 'lease'>, run: () => T): T { return scope.run(value, run) }
// Work started from a person's turn that runs on its own (titles, memory) waits in the background line.
export function asBackground<T>(run: () => T): T { return scope.run({ interactive: false }, run) }
// A tool of a turn that holds a slot. Nested turns take a free slot or borrow the parent's (one at a time),
// so they never wait on their own parent and never run past the target.
export function insideSlot<T>(run: () => T): T { return scope.run({ interactive: false, inside: true, lease: scope.getStore()?.lease }, run) }
export const currentLease = (): Lease | undefined => scope.getStore()?.lease
// A long-lived session's callbacks run in the context it was opened in, so each turn names its own lease.
export function inTurnSlot<T>(lease: Lease | undefined, run: () => T): T { return lease ? withLease(lease, run) : insideSlot(run) }
export function withLease<T>(lease: Lease, run: () => T): T { return scope.run({ interactive: false, inside: true, lease }, run) }
// While a turn waits for the person (an approval card, a question), its slot goes to the next turn in line
// and is taken back, in the turn's own priority, once the person has answered.
export async function whileWaitingForPerson<T>(run: () => Promise<T>): Promise<T> {
  const lease = scope.getStore()?.lease
  if (!lease) return run()
  lease.pause()
  try { return await run() } finally { await lease.resume() }
}

// The same, around an asking function (approval cards): the slot goes to the next turn while the person decides.
export const lendingSlot = <A extends unknown[], R>(ask: (...args: A) => Promise<R>) => (...args: A): Promise<R> => whileWaitingForPerson(() => ask(...args))

// One turn's hold on the pool: a real slot, or a borrowed turn of its parent's slot.
export class Lease {
  private free: (() => void) | null
  private pauses = 0
  private ended = false
  private resuming: Promise<void> | null = null
  private chain: Promise<void> = Promise.resolve()
  constructor(private readonly pool: WorkerPool, free: () => void, readonly interactive: boolean, private readonly signal?: AbortSignal) { this.free = free }
  get held(): boolean { return this.free !== null }
  pause(): void {
    if (this.pauses++ > 0 || !this.free) return
    const free = this.free
    this.free = null
    free()
  }
  resume(): Promise<void> {
    if (this.pauses > 0) this.pauses--
    if (this.pauses > 0 || this.ended || this.free) return this.resuming ?? Promise.resolve()
    this.resuming ??= (async () => {
      const free = await scope.run({ interactive: this.interactive }, () => this.pool.acquire(this.signal))
      if (this.ended || this.pauses > 0) free?.()
      else this.free = free
    })().finally(() => { this.resuming = null })
    return this.resuming
  }
  // Nested turns of this lease's holder run one at a time in its slot while the holder waits on them.
  borrow(): Promise<() => void> {
    let unlock!: () => void
    const next = new Promise<void>(resolve => { unlock = resolve })
    const ready = this.chain
    this.chain = ready.then(() => next)
    return ready.then(() => { let done = false; return () => { if (!done) { done = true; unlock() } } })
  }
  end(): void {
    this.ended = true
    const free = this.free
    this.free = null
    free?.()
  }
}

interface Waiter { interactive: boolean; ready: boolean; grant(release: () => void): void; timer?: NodeJS.Timeout }

export class WorkerPool {
  readonly base: number
  target: number
  running = 0
  private healthy = 0
  private readonly waiters: Waiter[] = []
  private sampling: Promise<void> | null = null
  private ticker: NodeJS.Timeout | undefined
  private readonly sample: () => Promise<Sample>
  private readonly intervalMs: number
  private readonly log: (line: string) => void
  private readonly targetListeners: ((target: number) => void)[] = []

  constructor(opts: { base: number; sample: () => Promise<Sample>; intervalMs?: number; log?: (line: string) => void }) {
    this.base = opts.base
    this.target = opts.base
    this.sample = opts.sample
    this.intervalMs = opts.intervalMs ?? 5000
    this.log = opts.log ?? (line => flog('worker-pool', line))
  }

  get queued(): number { return this.waiters.length }

  // Called after every target change, so the idle warm-session cap follows the target at once.
  onTarget(listener: (target: number) => void): void { this.targetListeners.push(listener) }

  acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) return Promise.resolve(null)
    const store = scope.getStore()
    if (store?.inside) {
      const lease = store.lease
      if (!lease) return Promise.resolve(() => undefined)
      if (this.running < this.target && this.waiters.length === 0) { this.running++; return Promise.resolve(this.releaser()) }
      if (lease.held) return lease.borrow().then(release => { if (!signal?.aborted) return release; release(); return null })
    }
    if (!this.ticker) {
      this.ticker = setInterval(() => void this.sampleNow(), this.intervalMs).unref()
      this.log(`base ${this.base}`)
    }
    return new Promise(resolve => {
      const onAbort = (): void => {
        const at = this.waiters.indexOf(waiter)
        if (at < 0) return
        this.waiters.splice(at, 1)
        clearTimeout(waiter.timer)
        resolve(null)
        this.pump()
      }
      const waiter: Waiter = { interactive: store?.interactive === true || store?.lease?.interactive === true, ready: false, grant: release => { signal?.removeEventListener('abort', onAbort); resolve(release) } }
      const say = store?.say
      if (waiter.interactive && say) waiter.timer = setTimeout(() => say(waitLine(store.korean === true)), 2000)
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      // Granted only after the target is re-read for this acquire.
      void this.sampleNow().finally(() => { waiter.ready = true; this.pump() })
    })
  }

  sampleNow(): Promise<void> {
    this.sampling ??= (async () => {
      try {
        const s = await this.sample()
        const old = this.target
        const next = nextTarget({ target: this.target, healthy: this.healthy }, this.base, s)
        this.target = next.target
        this.healthy = next.healthy
        if (old !== next.target) {
          this.log(`target ${old} -> ${next.target} (free ${Math.round(s.freePct)}%, swap +${Math.round(s.swapGrowthBytes / MB)} MB, cpu ${Math.round(s.cpuBusyPct)}%)`)
          for (const listener of this.targetListeners) { try { listener(next.target) } catch (err) { this.log(`target listener failed: ${err instanceof Error ? err.message : String(err)}`) } }
        }
      } catch (err) {
        this.log(`sample failed, target held at ${this.target}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        this.sampling = null
      }
      this.pump()
    })()
    return this.sampling
  }

  stop(): void {
    clearInterval(this.ticker)
    this.ticker = undefined
  }

  private pump(): void {
    while (this.running < this.target) {
      const ready = this.waiters.filter(w => w.ready)
      const next = ready.find(w => w.interactive) ?? ready[0]
      if (!next) return
      this.waiters.splice(this.waiters.indexOf(next), 1)
      clearTimeout(next.timer)
      this.running++
      next.grant(this.releaser())
    }
  }

  private releaser(): () => void {
    let done = false
    return () => {
      if (done) return
      done = true
      this.running--
      this.pump()
    }
  }

  // A turn's hold, so it can lend its slot while waiting for the person or to its nested turns.
  async lease(signal?: AbortSignal): Promise<Lease | null> {
    const store = scope.getStore()
    const free = await this.acquire(signal)
    return free ? new Lease(this, free, store?.interactive === true || store?.lease?.interactive === true, signal) : null
  }
}

export const workerPool = new WorkerPool({ base: workerBase(os.totalmem(), os.cpus().length), sample: sampler() })
