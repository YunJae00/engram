import { AsyncLocalStorage } from 'node:async_hooks'
import type { Engine, EngineEvent, EngineJobInput } from 'core'
import { currentModelCallContext, withModelCallContext } from './model-call-metrics.js'

const scopes = new AsyncLocalStorage<Map<string, () => void>>()
const engines = new Map<string, { tasks: number; idleAt: number }>()
export const MODEL_IDLE_MS = 30_000

export function modelTaskScope<T>(run: () => T): T {
  if (scopes.getStore()) return run()
  const held = new Map<string, () => void>()
  const finish = () => { for (const release of held.values()) release(); held.clear() }
  return scopes.run(held, () => {
    try {
      const result = run()
      if (result instanceof Promise) return result.finally(finish) as T
      finish()
      return result
    } catch (error) { finish(); throw error }
  })
}

export async function enterModelCall(engine: string, task: boolean, signal?: AbortSignal): Promise<() => void> {
  const state = engines.get(engine) ?? { tasks: 0, idleAt: -Infinity }
  engines.set(engine, state)
  if (task) {
    const scope = scopes.getStore()
    if (scope?.has(engine)) return () => {}
    state.tasks++
    const release = () => { state.tasks--; state.idleAt = Date.now() }
    if (scope) { scope.set(engine, release); return () => {} }
    return release
  }
  while (state.tasks || Date.now() - state.idleAt < MODEL_IDLE_MS) {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('cancelled')) }
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, state.tasks ? 1000 : Math.min(1000, Math.max(1, MODEL_IDLE_MS - (Date.now() - state.idleAt))))
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  signal?.throwIfAborted()
  return () => {}
}

export function holdModelTaskEngine(engine: string): void {
  if (currentModelCallContext()?.purpose === 'task' && scopes.getStore()) void enterModelCall(engine, true)
}

export function gateModelCalls<T extends Engine>(engine: T): T {
  const run = engine.run.bind(engine)
  engine.run = async function* (job: EngineJobInput): AsyncIterable<EngineEvent> {
    const task = currentModelCallContext()?.purpose === 'task'
    const release = await enterModelCall(engine.id, task, job.signal)
    const input = task ? job : { ...job, effort: 'low' as const }
    const iterator = withModelCallContext(currentModelCallContext() ?? { channel: 'background', purpose: 'memory-maintenance' }, () => run(input)[Symbol.asyncIterator]())
    try {
      for (;;) {
        const next = await withModelCallContext(currentModelCallContext() ?? { channel: 'background', purpose: 'memory-maintenance' }, () => iterator.next())
        if (next.done) break
        yield next.value
      }
    } finally { try { await iterator.return?.() } finally { release() } }
  }
  const tools = engine.runTools?.bind(engine)
  if (tools) engine.runTools = async job => {
    const task = currentModelCallContext()?.purpose === 'task'
    const release = await enterModelCall(engine.id, task, job.signal)
    try { return await withModelCallContext(currentModelCallContext() ?? { channel: 'background', purpose: 'conversation' }, () => tools(task ? job : { ...job, effort: 'low' })) }
    finally { release() }
  }
  const quick = engine.quick?.bind(engine)
  // Asides answer words said while a comet works, so they never wait for the engine to go idle.
  if (quick) engine.quick = (prompt, options) => withModelCallContext({ channel: currentModelCallContext()?.channel ?? 'aside', purpose: 'aside' }, () => quick(prompt, options))
  return engine
}
