import { createInterface } from 'node:readline'
import { ProcessClient } from './process-client.js'

type Payload = Record<string, unknown>
interface Pending { resolve(value: Payload): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

// Dedicated development transport; account probes and ordinary chats stay independent.
export class DevRpc {
  private readonly child: ProcessClient
  private readonly pending = new Map<number, Pending>()
  private serial = 0
  private failure?: Error
  constructor(binary: string, options: { cwd: string; env: NodeJS.ProcessEnv; trustedProject?: boolean },
    private readonly notify: (method: string, params: Payload) => void,
    private readonly request: (method: string, params: Payload) => Promise<unknown>,
    private readonly ended: (error: Error) => void) {
    const trust = `projects.${JSON.stringify(options.cwd)}.trust_level=${JSON.stringify(options.trustedProject ? 'trusted' : 'untrusted')}`
    const extensions = options.trustedProject ? ['-c', 'features.hooks=true'] : ['-c', 'features.hooks=false', '-c', 'notify=[]']
    this.child = new ProcessClient(binary, ['app-server', '-c', trust, ...extensions], { cwd: options.cwd, env: options.env, killTree: true })
    this.child.stderr.resume()
    this.child.on('error', error => this.close(error))
    this.child.on('exit', () => this.close(new Error('The development runtime disconnected.')))
    this.child.stdin.on('error', error => this.close(error))
    createInterface({ input: this.child.stdout }).on('error', error => this.close(error)).on('line', line => this.receive(line))
  }
  private receive(line: string): void {
    if (this.failure) return
    if (line.length > 4_194_304) { this.close(new Error('The development response exceeded the size limit.')); return }
    try {
      const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Payload; result?: Payload; error?: { message?: string } }
      if (!message || typeof message !== 'object') throw new Error('Invalid runtime event.')
      if (typeof message.method === 'string') {
        const params = message.params && typeof message.params === 'object' ? message.params : {}
        if (message.id !== undefined) {
          const id = message.id
          void this.request(message.method, params).then(result => this.write({ id, result }), error => this.write({ id, error: { code: -32603, message: error instanceof Error ? error.message : 'Request rejected.' } }))
        } else this.notify(message.method, params)
      } else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message ?? 'The runtime request failed.'))
        else pending.resolve(message.result ?? {})
      }
    } catch (error) { this.close(error instanceof Error ? error : new Error('Invalid runtime event.')) }
  }
  private write(message: unknown): void {
    if (!this.failure) this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  async initialize(): Promise<void> {
    await this.send('initialize', { clientInfo: { name: 'engram', title: 'Engram', version: '1.0' }, capabilities: { experimentalApi: true } })
    this.write({ method: 'initialized' })
  }
  send(method: string, params: Payload, timeout = 60_000): Promise<Payload> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error(`${method} did not respond in time.`)), timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  close(error = new Error('The development connection was closed.')): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.child.kill()
    this.ended(error)
  }
  async shutdown(): Promise<void> { this.close(); await this.child.waitForClose() }
}
