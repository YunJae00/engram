import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const workers = vi.hoisted(() => [] as Array<EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> }>)
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  postMessage = vi.fn()
  terminate = vi.fn().mockResolvedValue(1)
  constructor() { super(); workers.push(this) }
} }))
import { EmbeddingClient } from '../src/main/embedding-client.js'
afterEach(() => { vi.useRealTimers(); workers.length = 0 })

it('loads once, maps transferred vectors and rejects concurrent or invalid replies', async () => {
  const client = new EmbeddingClient('/models', 'example/model')
  const worker = workers[0]!
  expect(worker.postMessage).toHaveBeenCalledWith({ id: 1, texts: undefined })
  worker.emit('message', { id: 1 })
  await client.ready
  const first = client.embed(['one', 'two'])
  await expect(client.embed(['overlap'])).rejects.toThrow('busy')
  worker.emit('message', { id: 2, data: new Float32Array([1, 0, 0, 1]), dim: 2 })
  expect((await first).map(vector => [...vector])).toEqual([[1, 0], [0, 1]])
  const invalid = client.embed(['one'])
  worker.emit('message', { id: 3, data: new Float32Array([NaN]), dim: 1 })
  await expect(invalid).rejects.toThrow('Invalid embedding')
  await client.close()
})

it('rejects startup failure and terminates the worker exactly once', async () => {
  const client = new EmbeddingClient('/models', 'example/model')
  const result = expect(client.ready).rejects.toThrow('cannot load')
  workers[0]!.emit('error', new Error('cannot load'))
  await result
  await client.close()
  expect(workers[0]!.terminate).toHaveBeenCalledTimes(1)
  await expect(client.embed(['later'])).rejects.toThrow('cannot load')
})

it('settles a timed-out inference and permits a fresh worker afterward', async () => {
  vi.useFakeTimers()
  const client = new EmbeddingClient('/models', 'example/model')
  workers[0]!.emit('message', { id: 1 })
  await client.ready
  const result = expect(client.embed(['one'])).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(60_000)
  await result
  expect(client.closed).toBe(true)
  const fresh = new EmbeddingClient('/models', 'example/model')
  workers[1]!.emit('message', { id: 1 })
  await fresh.ready
  await fresh.close()
})

it('rejects an in-flight request on shutdown or unexpected exit', async () => {
  for (const exit of [false, true]) {
    const client = new EmbeddingClient('/models', 'example/model')
    const result = expect(client.ready).rejects.toThrow(/closed|exited/)
    if (exit) workers.at(-1)!.emit('exit', 0)
    else await client.close()
    await result
  }
})
