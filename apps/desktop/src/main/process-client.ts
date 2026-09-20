import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { Worker } from 'node:worker_threads'

interface Options { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; killTree?: boolean }
const owned = new Set<ProcessClient>()
let closing = false
export const runtimeProcessesRunning = () => !closing && owned.size > 0
export async function stopRuntimeProcesses(): Promise<void> {
  closing = true
  await Promise.allSettled([...owned].map(child => { child.kill(); return child.waitForClose() }))
}

// Process creation itself can block on Windows. Keep it off the UI's main thread.
export class ProcessClient extends EventEmitter {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  pid?: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  private closed = false
  private exited = false
  private writing?: (error?: Error | null) => void
  private readonly worker: Worker

  constructor(command: string, args: string[], options: Options = {}) {
    super()
    if (closing) throw new Error('The app is closing.')
    options.signal?.throwIfAborted()
    this.worker = new Worker(new URL('./process-worker.js', import.meta.url), {
      workerData: { command, args, cwd: options.cwd, env: options.env ?? { ...process.env }, killTree: options.killTree === true },
    })
    owned.add(this)
    this.stdout = this.output('stdout')
    this.stderr = this.output('stderr')
    this.stdin = new Writable({
      write: (data, _encoding, callback) => {
        if (this.closed) { callback(new Error('Process is closed')); return }
        this.writing = callback
        this.worker.postMessage({ type: 'write', data })
      },
      final: callback => { if (!this.closed) this.worker.postMessage({ type: 'end' }); callback() },
      destroy: (error, callback) => { if (!this.closed) this.worker.postMessage({ type: 'destroy', stream: 'stdin' }); callback(error) },
    })
    const abort = () => this.kill()
    options.signal?.addEventListener('abort', abort, { once: true })
    this.once('close', () => options.signal?.removeEventListener('abort', abort))
    this.worker.on('message', message => {
      if (message.type === 'spawn') { this.pid = message.pid; this.emit('spawn') }
      else if (message.type === 'data') {
        const stream = message.stream as 'stdout' | 'stderr'
        if (this[stream].push(Buffer.from(message.data))) this.worker.postMessage({ type: 'resume', stream })
      } else if (message.type === 'end') this[message.stream as 'stdout' | 'stderr'].push(null)
      else if (message.type === 'written') {
        const callback = this.writing
        this.writing = undefined
        callback?.(message.error ? new Error(message.error) : undefined)
      } else if (message.type === 'inputError') this.stdin.destroy(new Error(message.error))
      else if (message.type === 'error') this.emit('error', Object.assign(new Error(message.error), { code: message.code, syscall: message.syscall }))
      else if (message.type === 'exit') this.exit(message.code, message.signal)
      else if (message.type === 'close') this.close(message.code, message.signal)
    })
    this.worker.on('error', error => { this.emit('error', error); this.close(null, null) })
    this.worker.on('exit', () => this.close(this.exitCode, this.signalCode))
  }

  private output(stream: 'stdout' | 'stderr'): Readable {
    return new Readable({
      read: () => { if (!this.closed) this.worker.postMessage({ type: 'resume', stream }) },
      destroy: (error, callback) => { if (!this.closed) this.worker.postMessage({ type: 'destroy', stream }); callback(error) },
    })
  }

  private exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }

  private close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return
    this.closed = true
    owned.delete(this)
    this.exit(code, signal)
    this.stdout.push(null)
    this.stderr.push(null)
    const callback = this.writing
    this.writing = undefined
    callback?.(new Error('Process closed before accepting input'))
    this.emit('close', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.closed || this.exited) return false
    this.killed = true
    this.worker.postMessage({ type: 'kill', signal })
    return true
  }
  waitForClose(timeout = 20_000): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const closed = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { this.off('close', closed); reject(new Error('The owned process did not stop in time.')) }, timeout)
      this.once('close', closed)
    })
  }
}

export function spawnRuntime(options: Options & { command: string; args: string[] }): ProcessClient {
  const child = new ProcessClient(options.command, options.args, options)
  child.stderr.resume()
  return child
}
