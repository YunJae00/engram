import { describe, expect, it } from 'vitest'
import { LocalAdapter } from '../src/engine/local.js'
import type { LocalTransport } from '../src/engine/local.js'
import type { EngineEvent } from '../src/engine/types.js'

// The adapter's whole contract: a transport that turns prompt→text becomes
// EngineEvents, with timeouts, cancels and empties all accounted for.

async function collect(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const adapter = (t: Partial<LocalTransport>) =>
  new LocalAdapter({ configured: async () => true, complete: async () => 'x', ...t })

describe('LocalAdapter', () => {
  it('turns a completion into token+result', async () => {
    const events = await collect(
      adapter({ complete: async () => '{"title":"ok"}' }).run({ prompt: 'p', workdir: process.cwd() as never }),
    )
    expect(events.at(-1)).toEqual({ type: 'result', text: '{"title":"ok"}' })
  })

  it('an empty answer is an error, not a silent success', async () => {
    const events = await collect(
      adapter({ complete: async () => '   ' }).run({ prompt: 'p', workdir: process.cwd() as never }),
    )
    expect(events[0]?.type).toBe('error')
  })

  it('a transport crash reads as crash kind', async () => {
    const events = await collect(
      adapter({
        complete: async () => {
          throw new Error('boom')
        },
      }).run({ prompt: 'p', workdir: process.cwd() as never }),
    )
    const error = events[0] as Extract<EngineEvent, { type: 'error' }>
    expect(error.kind).toBe('crash')
  })

  it('the job timeout aborts the transport and reads as timeout', async () => {
    const events = await collect(
      adapter({
        complete: (_p, opts) =>
          new Promise((_res, reject) => {
            opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      }).run({ prompt: 'p', workdir: process.cwd() as never, timeoutMs: 80 }),
    )
    const error = events[0] as Extract<EngineEvent, { type: 'error' }>
    expect(error.kind).toBe('timeout')
  })

  it('caller abort ends silently — no error event', async () => {
    const controller = new AbortController()
    const run = collect(
      adapter({
        complete: (_p, opts) =>
          new Promise((_res, reject) => {
            opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      }).run({ prompt: 'p', workdir: process.cwd() as never, signal: controller.signal }),
    )
    setTimeout(() => controller.abort(), 40)
    expect(await run).toEqual([])
  })

  it('streams each chunk as its own token event, then the whole answer', async () => {
    const events = await collect(
      adapter({
        complete: async (_p, opts) => {
          for (const piece of ['Hel', 'lo ', 'there']) {
            opts.onToken?.(piece)
            await new Promise((r) => setTimeout(r, 1))
          }
          return 'Hello there'
        },
      }).run({ prompt: 'p', workdir: process.cwd() as never }),
    )
    expect(events.filter((e) => e.type === 'token').map((e) => (e as { text: string }).text)).toEqual([
      'Hel',
      'lo ',
      'there',
    ])
    expect(events.at(-1)).toEqual({ type: 'result', text: 'Hello there' })
  })

  it('a transport that never streams still emits the answer once', async () => {
    const events = await collect(
      adapter({ complete: async () => 'whole' }).run({ prompt: 'p', workdir: process.cwd() as never }),
    )
    expect(events).toEqual([
      { type: 'token', text: 'whole' },
      { type: 'result', text: 'whole' },
    ])
  })

  it('a crash after partial streaming still reports the error', async () => {
    const events = await collect(
      adapter({
        complete: async (_p, opts) => {
          opts.onToken?.('half an ')
          throw new Error('boom')
        },
      }).run({ prompt: 'p', workdir: process.cwd() as never }),
    )
    expect(events[0]).toEqual({ type: 'token', text: 'half an ' })
    expect((events.at(-1) as Extract<EngineEvent, { type: 'error' }>).kind).toBe('crash')
  })

  it('detect mirrors configured()', async () => {
    expect((await adapter({ configured: async () => false }).detect()).installed).toBe(false)
    expect((await adapter({}).detect()).installed).toBe(true)
  })
})
