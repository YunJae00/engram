import { AsyncLocalStorage } from 'node:async_hooks'
import { flog } from './flog.js'

type CallContext = { channel: string; task?: string; turn?: number; purpose: string }
const context = new AsyncLocalStorage<CallContext>()
const recent = new Map<string, CallContext>()
const counts = new Map<string, number>()
let serial = 0

export function withModelCallContext<T>(value: CallContext, run: () => T): T {
  const parent = context.getStore() ?? recent.get(value.channel)
  const current = { ...parent, ...value }
  if (value.task) {
    recent.delete(value.channel)
    recent.set(value.channel, current)
    if (recent.size > 128) recent.delete(recent.keys().next().value!)
  }
  return context.run(current, run)
}

export function modelCall(engine: string, promptChars: number, effort?: string, toolCount = 0): { token(): void; end(): void } {
  const current = context.getStore()
  const key = JSON.stringify([current?.channel, current?.task, current?.turn])
  const count = (counts.get(key) ?? 0) + 1
  counts.delete(key); counts.set(key, count)
  if (counts.size > 128) counts.delete(counts.keys().next().value!)
  const fields = { engine, call: ++serial, ...current, count, promptChars, toolCount, effort: effort ?? 'runtime-default' }
  const started = Date.now()
  let first = true
  flog('model-call', JSON.stringify({ ...fields, phase: 'start' }))
  return {
    token() { if (first) { first = false; flog('model-call', JSON.stringify({ ...fields, phase: 'first-token', ms: Date.now() - started })) } },
    end() { flog('model-call', JSON.stringify({ ...fields, phase: 'end', ms: Date.now() - started })) },
  }
}
