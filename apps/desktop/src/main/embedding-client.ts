import { Worker } from 'node:worker_threads'

interface Reply { id: number; error?: string; data?: Float32Array; dim?: number }

// One request at a time; the semantic queue owns scheduling and backpressure.
export class EmbeddingClient {
  private worker: Worker
  private serial = 0
  private failure: Error | null = null
  private stopping?: Promise<void>
  private pending?: { id: number; resolve(reply: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  readonly ready: Promise<void>

  constructor(root: string, model: string) {
    this.worker = new Worker(new URL('./embedding-worker.js', import.meta.url), { workerData: { root, model } })
    this.worker.on('message', (reply: Reply) => {
      const pending = this.pending
      if (!pending || reply.id !== pending.id) return
      clearTimeout(pending.timer)
      this.pending = undefined
      if (reply.error) pending.reject(new Error(reply.error))
      else pending.resolve(reply)
    })
    this.worker.on('error', error => { void this.close(error) })
    this.worker.on('exit', () => { void this.close(new Error('Embedding worker exited')) })
    this.ready = this.request().then(() => undefined)
  }

  get closed(): boolean { return this.failure !== null }

  private request(texts?: string[]): Promise<Reply> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending) return Promise.reject(new Error('Embedding worker is busy'))
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(new Error('Embedding worker timed out')) }, texts ? 60_000 : 120_000)
      this.pending = { id, resolve, reject, timer }
      try { this.worker.postMessage({ id, texts }) }
      catch (error) { void this.close(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const { data, dim } = await this.request(texts)
    if (!(data instanceof Float32Array) || !Number.isInteger(dim) || !dim || dim < 1 || data.length !== texts.length * dim || !data.every(Number.isFinite)) throw new Error('Invalid embedding result')
    return texts.map((_, index) => data.subarray(index * dim, (index + 1) * dim))
  }

  close(error = new Error('Embedding worker closed')): Promise<void> {
    if (this.stopping) return this.stopping
    this.failure = error
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(error)
      this.pending = undefined
    }
    this.stopping = this.worker.terminate().then(() => undefined, () => undefined)
    return this.stopping
  }
}
