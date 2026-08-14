import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { parseRetryAfterMs } from './claude.js'
import { errorEvent, killTree, spawnEngineChild } from './spawn.js'
import type { EngineEvent } from './types.js'

export interface ChatSessionOptions {
  workdir: string
  // Per-turn budget. A turn that exceeds it ends with a 'timeout' error event
  // and the session dies with it.
  turnTimeoutMs: number
}

interface TurnSink {
  push(event: EngineEvent): void
  finish(): void
  streamedDelta: boolean
}

export interface EngineChatSession {
  start(): void
  isAlive(): boolean
  close(): void
  send(prompt: string, signal?: AbortSignal): AsyncIterable<EngineEvent>
  // Completed turns — turn 0 is where the caller ships rules + history.
  readonly turns: number
  readonly lastUsedAt: number
}

export class ClaudeChatSession implements EngineChatSession {
  private child: ChildProcess | null = null
  private closed = false
  private busy = false
  private sink: TurnSink | null = null
  private stderrTail = ''
  turns = 0
  lastUsedAt = Date.now()

  constructor(
    private readonly binary: string,
    private readonly args: string[],
    private readonly opts: ChatSessionOptions,
  ) {}

  start(): void {
    if (this.child) return
    const child = spawnEngineChild(this.binary, this.args, this.opts.workdir)
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-500)
    })
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => this.onLine(line))
    }
    const die = (message: string): void => {
      if (this.closed) return
      this.closed = true
      const sink = this.sink
      if (sink) {
        sink.push(errorEvent(message))
        sink.finish()
      }
    }
    child.on('exit', (code) => die(`claude chat session exited ${code}: ${this.stderrTail}`))
    child.on('error', (err) => die(`claude chat session failed to start: ${String(err)}`))
  }

  isAlive(): boolean {
    return this.child !== null && !this.closed && this.child.exitCode === null && this.child.signalCode === null
  }

  close(): void {
    this.closed = true
    if (this.child) killTree(this.child)
  }

  private onLine(raw: string): void {
    const line = raw.trim()
    if (!line.startsWith('{')) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const sink = this.sink
    if (!sink) return // between turns: init lines, summaries — nobody asked
    // Mirrors run()'s parseStreamJson exactly: deltas OR the assembled
    // assistant message (never both), then the authoritative result line.
    if (parsed['type'] === 'stream_event') {
      const event = parsed['event'] as { type?: string; delta?: { type?: string; text?: string } } | undefined
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        sink.streamedDelta = true
        sink.push({ type: 'token', text: event.delta.text })
      }
    } else if (parsed['type'] === 'assistant') {
      if (!sink.streamedDelta) {
        const message = parsed['message'] as { content?: { type: string; text?: string }[] } | undefined
        for (const block of message?.content ?? []) {
          if (block.type === 'text' && block.text) sink.push({ type: 'token', text: block.text })
        }
      }
    } else if (parsed['type'] === 'result') {
      if (parsed['is_error']) {
        const message = String(parsed['result'] ?? 'claude error result')
        const retryAfterMs = parseRetryAfterMs(message)
        const base = errorEvent(message)
        if (base.type === 'error' && retryAfterMs !== undefined) sink.push({ ...base, retryAfterMs })
        else sink.push(base)
      } else {
        sink.push({ type: 'result', text: String(parsed['result'] ?? '') })
      }
      sink.finish()
    }
  }

  async *send(prompt: string, signal?: AbortSignal): AsyncIterable<EngineEvent> {
    if (!this.isAlive() || !this.child?.stdin?.writable) {
      yield errorEvent('chat session is not alive')
      return
    }
    if (this.busy) {
      yield errorEvent('chat session busy: a turn is already in flight')
      return
    }
    this.busy = true
    this.lastUsedAt = Date.now()
    const queue: EngineEvent[] = []
    let done = false
    let wake: () => void = () => undefined
    let aborted = false
    this.sink = {
      streamedDelta: false,
      push: (event) => {
        queue.push(event)
        wake()
      },
      finish: () => {
        done = true
        wake()
      },
    }
    const timer = setTimeout(() => {
      // The turn blew its budget: the session is in an unknown state, so it
      // dies whole. classify reads the marker as kind 'timeout'.
      this.sink?.push(errorEvent(`[engram] timed out after ${this.opts.turnTimeoutMs}ms`))
      this.sink?.finish()
      this.close()
    }, this.opts.turnTimeoutMs)
    const onAbort = (): void => {
      // The caller's own hand — end silently (run()'s cancel contract).
      aborted = true
      done = true
      this.close()
      wake()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      this.child.stdin.write(
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`,
      )
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift()!
          if (!aborted) yield event
        }
        if (done && queue.length === 0) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.sink = null
      this.busy = false
      this.turns += 1
      this.lastUsedAt = Date.now()
    }
  }
}
