import { app } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { flog } from './flog.js'
import { recoverableDesktopFailure } from './desktop-recovery.js'

export type DesktopMethod = 'listApps' | 'openApp' | 'inputState' | 'listWindows' | 'inspectWindow' | 'activateWindow' | 'applicationFrame' | 'observe' | 'capture' | 'prepare' | 'bind' | 'work' | 'idle' | 'click' | 'type' | 'replace' | 'scroll' | 'key' | 'stop' | 'documentRead' | 'documentEdit' | 'documentCompose'
const METHODS = new Set<DesktopMethod>(['listApps', 'openApp', 'inputState', 'listWindows', 'inspectWindow', 'activateWindow', 'applicationFrame', 'observe', 'capture', 'prepare', 'bind', 'work', 'idle', 'click', 'type', 'replace', 'scroll', 'key', 'stop', 'documentRead', 'documentEdit', 'documentCompose'])
// Everything else names one window; these two speak about the session.
const UNSCOPED = new Set<DesktopMethod>(['listApps', 'openApp', 'inputState', 'listWindows', 'stop'])

interface PendingRequest {
  method: DesktopMethod
  generation: number
  resolve(value: unknown): void
  reject(error: Error): void
  timer?: ReturnType<typeof setTimeout>
}

function nativeLease(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value && !value.includes('\0')
}

export class DesktopHost {
  private ended = false
  private child?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private readyTimer?: ReturnType<typeof setTimeout>
  private rejectReady?: (error: Error) => void
  private serial = 0
  private generation = 0
  private currentNative?: string
  private revoked = new Map<string, string>()
  private pending = new Map<number, PendingRequest>()

  constructor(private onRevoked: (reason: string) => void = () => undefined) {}
  get closed(): boolean { return this.ended }
  static available(): boolean { return process.platform === 'win32' && existsSync(DesktopHost.path()) }
  private static path(): string {
    return app.isPackaged ? join(process.resourcesPath, 'bin', 'desktop', 'EngramDesktop.exe')
      : fileURLToPath(new URL('../../native-bin/desktop/EngramDesktop.exe', import.meta.url))
  }

  private start(): Promise<void> {
    if (this.ended) throw new Error('Computer access ended. Reconnect the window to continue.')
    if (this.ready) return this.ready
    if (!DesktopHost.available()) throw new Error('Computer control is available on Windows in this build.')
    const child = spawn(DesktopHost.path(), ['--owner-pid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    child.stderr.resume()
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject
      const fail = (cause?: unknown) => {
        if (this.ended) return
        const detail = cause instanceof Error ? cause.message.slice(0, 500) : 'The native process or its pipe exited.'
        flog('desktop-native-connection', detail)
        this.close(new Error(`The computer connection closed. ${detail}`))
      }
      this.readyTimer = setTimeout(() => fail(new Error('The native helper did not become ready within 10 seconds.')), 10000)
      child.once('error', fail)
      child.once('exit', fail)
      child.stdin.once('error', fail)
      child.stdout.once('error', fail)
      child.stderr.once('error', fail)
      createInterface({ input: child.stdout }).on('error', fail).on('line', (line) => {
        if (this.ended) return
        if (line.length > 524288) { fail(); return }
        let message: { id?: number; type?: string; protocol?: number; control?: boolean; result?: unknown; error?: string; reason?: string; lease?: unknown }
        try { message = JSON.parse(line) as typeof message } catch { return }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return
        if (message.type === 'ready') {
          if (message.protocol !== 2 || message.control !== true) { fail(); return }
          clearTimeout(this.readyTimer)
          this.rejectReady = undefined
          resolve()
          return
        }
        if (message.type === 'fatal') { fail(new Error(typeof message.error === 'string' ? message.error : 'Native startup failed.')); return }
        if (message.type === 'revoked') {
          if (!nativeLease(message.lease)) { fail(); return }
          const reason = typeof message.reason === 'string' ? message.reason.slice(0, 500) : 'Computer control stopped.'
          flog('desktop-native-revoked', reason)
          if (!this.rememberRevoked(message.lease, reason)) return
          if (message.lease === this.currentNative) {
            this.invalidate(reason)
            this.onRevoked(reason)
          }
          return
        }
        if (!Number.isSafeInteger(message.id)) return
        const pending = this.pending.get(message.id!)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(message.id!)
        if (pending.generation !== this.generation) { pending.reject(new Error('Computer action was cancelled.')); return }
        if (message.error) {
          const error = new Error(typeof message.error === 'string' ? message.error.slice(0, 500) : 'The desktop request failed.')
          flog('desktop-native-error', `${pending.method}: ${error.message}`)
          pending.reject(error)
          if ((pending.method === 'bind' || pending.method === 'prepare') && !recoverableDesktopFailure(error.message)) this.close(error)
          return
        }
        if (pending.method === 'bind') {
          const result = message.result as { lease?: unknown } | null
          const id = result && typeof result === 'object' && !Array.isArray(result) ? result.lease : undefined
          if (!nativeLease(id) || this.revoked.has(id)) {
            const reason = nativeLease(id) ? this.revoked.get(id) : undefined
            const error = new Error(reason ? `Desktop control was revoked: ${reason}` : 'Desktop control was revoked or its native lease could not be verified.')
            pending.reject(error)
            this.close(error)
            return
          }
          this.currentNative = id
        }
        pending.resolve(message.result)
      })
    })
    return this.ready
  }

  private rememberRevoked(id: string, reason: string): boolean {
    if (!this.revoked.has(id) && this.revoked.size >= 128) {
      this.close(new Error('The desktop revocation history is full. Reconnect the window.'))
      return false
    }
    this.revoked.set(id, reason)
    return true
  }

  private invalidate(reason: string): void {
    this.generation++
    const prior = this.currentNative
    this.currentNative = undefined
    if (prior) this.rememberRevoked(prior, reason)
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.reject(new Error(reason))
    }
  }

  async request<T>(method: DesktopMethod, args: Record<string, unknown>): Promise<T> {
    if (!METHODS.has(method)) throw new Error('Unsupported computer action.')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid computer action.')
    if (!UNSCOPED.has(method) && (typeof args['window'] !== 'string' || !/^\d{1,20}$/.test(args['window']) || !Number.isSafeInteger(args['pid']) || Number(args['pid']) < 0)) throw new Error('Choose a valid app window.')
    if (method === 'stop') this.invalidate('Computer action was cancelled by Stop.')
    if (this.ended) throw new Error('Computer access ended. Reconnect the window to continue.')
    if (this.pending.size >= 32) throw new Error('Too many desktop requests are in flight.')
    if (method === 'bind' && (this.currentNative || [...this.pending.values()].some((request) => request.method === 'bind'))) throw new Error('A native control grant is already active or pending.')
    const generation = this.generation
    const id = ++this.serial
    let line = JSON.stringify({ ...args, id, method }) + '\n'
    if (line.length > 65536) throw new Error('The desktop request is too large.')
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { method, generation, resolve: (value) => resolve(value as T), reject }
      this.pending.set(id, pending)
      let ready: Promise<void>
      try { ready = this.start() }
      catch (error) { this.close(error instanceof Error ? error : new Error('The desktop helper could not start.')); return }
      void ready.then(async () => {
        if ((method === 'bind' || method === 'activateWindow') && this.pending.get(id) === pending && this.child?.pid) {
          const pid = this.child.pid
          if (method === 'bind') {
            const input = await this.request<{ intervention: string }>('prepare', args)
            if (!/^\d{1,20}$/.test(input.intervention)) throw new Error('Desktop input monitoring could not be verified.')
            if (this.pending.get(id) !== pending || this.ended) return
            line = JSON.stringify({ ...args, id, method, intervention: input.intervention }) + '\n'
          }
          await new Promise<void>((done) => {
            execFile(DesktopHost.path(), ['--owner-pid', String(process.pid), '--grant-foreground', String(pid)],
              { windowsHide: true, timeout: 1500 }, (error) => {
                if (error) flog('desktop-foreground-grant', 'Foreground delegation was unavailable; checking native activation.')
                done()
              })
          })
        }
        if (this.pending.get(id) !== pending) return
        if (generation !== this.generation || this.ended || !this.child || this.child.stdin.destroyed) {
          this.pending.delete(id)
          reject(new Error('Computer action was cancelled.'))
          return
        }
        pending.timer = setTimeout(() => {
          if (this.pending.get(id) === pending) this.close(new Error('This app stopped responding. Computer control was stopped.'))
        }, method === 'documentCompose' ? 30000 : 8000)
        try {
          this.child.stdin.write(line, (error) => { if (error) this.close(error) })
        } catch (error) { this.close(error instanceof Error ? error : new Error('The desktop request could not be sent.')) }
      }, (error: unknown) => {
        if (this.pending.get(id) !== pending) return
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('The desktop helper could not start.'))
      }).catch((error: unknown) => {
        if (this.pending.get(id) !== pending) return
        if (error instanceof Error && recoverableDesktopFailure(error.message)) {
          this.pending.delete(id)
          reject(error)
        } else this.close(error instanceof Error ? error : new Error('Foreground delegation failed.'))
      })
    })
  }

  close(error = new Error('Computer access ended.')): void {
    if (this.ended) return
    this.ended = true
    this.generation++
    this.currentNative = undefined
    clearTimeout(this.readyTimer)
    this.rejectReady?.(error)
    this.rejectReady = undefined
    const child = this.child
    this.child = undefined
    if (child) {
      try { child.stdin.end() } catch { /* The pipe may already have closed. */ }
      try { child.kill() } catch { /* A process that exited cannot retain control. */ }
    }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.onRevoked(error.message)
  }
}
