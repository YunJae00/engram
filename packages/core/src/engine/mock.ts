import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { Engine, EngineDetection, EngineEvent, EngineJobInput } from './types.js'

// MockEngine replays canned responses (fixtures or injected). Every prompt
// built by jobs/prompts.ts carries a "JOB: <kind>" marker line; the response
// for that kind is replayed as a short token stream + result.
type MockResponse = string | ((prompt: string) => string)

export class MockEngine implements Engine {
  readonly id = 'mock' as const

  constructor(
    private responses: Record<string, MockResponse> = {},
    private opts: { hangTimes?: number } = {},
  ) {}

  private calls = 0

  static async fromDir(dir: string): Promise<MockEngine> {
    const responses: Record<string, MockResponse> = {}
    for (const file of await readdir(dir)) {
      const ext = extname(file)
      if (!['.json', '.md', '.txt'].includes(ext)) continue
      responses[file.slice(0, -ext.length)] = await readFile(join(dir, file), 'utf8')
    }
    return new MockEngine(responses)
  }

  async detect(): Promise<EngineDetection> {
    return { installed: true, loggedIn: true }
  }

  async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
    this.calls += 1
    if (this.opts.hangTimes !== undefined && this.calls <= this.opts.hangTimes) {
      const budget = job.timeoutMs ?? 300_000
      const aborted = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), budget)
        job.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve(true)
          },
          { once: true },
        )
      })
      if (aborted) return // a cancel ends silently, like the adapter
      yield { type: 'error', message: `[engram] timed out after ${budget}ms` }
      return
    }
    const kind = /^JOB: (\S+)/m.exec(job.prompt)?.[1] ?? 'default'
    const canned = this.responses[kind] ?? this.responses['default']
    if (canned === undefined) {
      yield { type: 'error', message: `mock: no canned response for job kind "${kind}"` }
      return
    }
    const text = typeof canned === 'function' ? canned(job.prompt) : canned
    // Emit token events with a small gap so streaming consumers render
    // progressively (chat panel acceptance).
    const step = Math.max(1, Math.ceil(text.length / 4))
    for (let i = 0; i < text.length; i += step) {
      yield { type: 'token', text: text.slice(i, i + step) }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    yield { type: 'result', text }
  }
}
