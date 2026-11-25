import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Engine, ToolSessionCall, ToolSessionResult } from './types.js'

export interface TraceCall { name: string; args: Record<string, unknown>; ms: number; length: number; hash: string; threw: boolean }

export type TraceRecord =
  | {
    kind: 'job'; at: string; sessionKey?: string; modelHint?: string; effort?: string
    system: string; systemHash: string; opening?: string; prompt: string
    menu: { name: string; description: number; schema: number }[]; maxCalls: number
    calls: TraceCall[]; firstTokenMs?: number; endMs: number; usage: number[]; answer: number; error?: string; note?: string
  }
  | { kind: 'quick'; at: string; prompt: string; endMs: number; answer: number; error?: string }

export type TraceSink = (record: TraceRecord) => void

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16)
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const clock = (): (() => number) => { const began = performance.now(); return () => Math.round(performance.now() - began) }

export function traced<T extends Engine>(engine: T, sink?: TraceSink): T {
  if (!sink) return engine
  const runTools = engine.runTools?.bind(engine)
  if (runTools) engine.runTools = async job => {
    const at = new Date().toISOString(), since = clock()
    const calls: TraceCall[] = [], usage: number[] = []
    let firstTokenMs: number | undefined, result: ToolSessionResult | undefined, error: string | undefined
    const tools = job.tools.map((tool): ToolSessionCall => ({
      ...tool,
      run: async args => {
        const call: TraceCall = { name: tool.name, args, ms: 0, length: 0, hash: '', threw: false }
        calls.push(call)
        const took = clock()
        try {
          const outcome = await tool.run(args)
          const text = typeof outcome === 'string' ? outcome : `${outcome.text}${outcome.image?.data ?? ''}`
          call.length = text.length
          call.hash = hashOf(text)
          return outcome
        } catch (thrown) {
          call.threw = true
          throw thrown
        } finally { call.ms = took() }
      },
    }))
    try {
      result = await runTools({
        ...job,
        tools,
        ...(job.onToken ? { onToken: (text: string) => { firstTokenMs ??= since(); job.onToken?.(text) } } : {}),
        ...(job.onUsage ? { onUsage: (tokens: number) => { usage.push(tokens); job.onUsage?.(tokens) } } : {}),
      })
      return result
    } catch (thrown) {
      error = messageOf(thrown)
      throw thrown
    } finally {
      sink({
        kind: 'job', at, sessionKey: job.sessionKey, modelHint: job.modelHint, effort: job.effort,
        system: job.system, systemHash: hashOf(job.system), opening: job.opening, prompt: job.prompt,
        menu: job.tools.map(tool => ({ name: tool.name, description: tool.description.length, schema: JSON.stringify(tool.argsSchema).length })),
        maxCalls: job.maxCalls, calls, firstTokenMs, endMs: since(), usage, answer: result?.answer.length ?? 0,
        error: error ?? result?.error, note: result?.note,
      })
    }
  }
  const quick = engine.quick?.bind(engine)
  if (quick) engine.quick = async (prompt, options) => {
    const at = new Date().toISOString(), since = clock()
    let answer = '', error: string | undefined
    try {
      answer = await quick(prompt, options)
      return answer
    } catch (thrown) {
      error = messageOf(thrown)
      throw thrown
    } finally { sink({ kind: 'quick', at, prompt, endMs: since(), answer: answer.length, error }) }
  }
  return engine
}

export function traceFolder(dir: string): TraceSink {
  return record => {
    void mkdir(dir, { recursive: true }).then(() => appendFile(join(dir, `${record.at.slice(0, 10)}.jsonl`), `${JSON.stringify(record)}\n`)).catch(() => undefined)
  }
}
