import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export class DesktopHost {
  private ended = false
  private child?: ChildProcessWithoutNullStreams
  private serial = 0
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()

  static available(): boolean { return process.platform === 'win32' && existsSync(DesktopHost.path()) }
  private static path(): string {
    return app.isPackaged ? join(process.resourcesPath, 'bin', 'desktop', 'EngramDesktop.exe')
      : fileURLToPath(new URL('../../native-bin/desktop/EngramDesktop.exe', import.meta.url))
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.ended) throw new Error('App sharing stopped. Reconnect the window to continue.')
    if (this.child) return this.child
    if (!DesktopHost.available()) throw new Error('App sharing is available on Windows in this build.')
    const child = spawn(DesktopHost.path(), ['--owner-pid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stderr.resume()
    const fail = () => this.close(new Error('The app-sharing connection closed. Reconnect the window to continue.'))
    child.once('error', fail)
    child.once('exit', fail)
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.length > 262144) { this.close(new Error('The app returned too much information.')); return }
      let message: { id?: number; result?: unknown; error?: string }
      try { message = JSON.parse(line) as typeof message } catch { return }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return
      const pending = this.pending.get(Number(message.id))
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(Number(message.id))
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result)
    })
    return child
  }

  request<T>(method: 'inspectWindow' | 'observe', args: { window: string; pid: number }): Promise<T> {
    if (method !== 'inspectWindow' && method !== 'observe') throw new Error('Only app inspection and reading are supported.')
    if (!args || typeof args !== 'object' || Object.keys(args).some((key) => key !== 'window' && key !== 'pid') || typeof args.window !== 'string' || !/^\d{1,20}$/.test(args.window) || !Number.isSafeInteger(args.pid) || args.pid < 0) throw new Error('Choose a valid app window.')
    const child = this.start()
    const id = ++this.serial
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('This app stopped responding to reading. Reconnect it to retry.')), 8000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.stdin.write(JSON.stringify({ id, method, window: args.window, pid: args.pid }) + '\n', (error) => {
        if (error) this.close(error)
      })
    })
  }

  close(error = new Error('App sharing stopped.')): void {
    this.ended = true
    const child = this.child
    this.child = undefined
    if (child) { child.removeAllListeners('exit'); child.removeAllListeners('error'); child.stdin.end(); child.kill() }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}
