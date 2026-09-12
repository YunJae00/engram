import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { OfficeOp } from 'core'
import { OFFICE_HOST_SCRIPT } from './office-script.js'

// One PowerShell process holds the Office applications for as long as a
// turn keeps asking; it leaves after a quiet spell so no Excel lingers in
// memory over a hidden bridge. Every request is a fixed operation with data
// arguments - the model's words never become code here.
const READY_MS = 20_000
const REQUEST_MS = 90_000
const IDLE_MS = 5 * 60_000
const LINE_CAP = 2_000_000

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; activity?: (window: string, name: string) => Promise<void> }
type Probe = { excel: boolean; word: boolean; powerpoint: boolean; outlook: boolean }

let child: ChildProcessWithoutNullStreams | undefined
let ready: Promise<void> | undefined
let serial = 0
let idle: ReturnType<typeof setTimeout> | undefined
let queue: Promise<unknown> = Promise.resolve()
let probed: Probe | null | undefined
let stopping: Promise<void> = Promise.resolve()
const pending = new Map<number, Pending>()

export function officeSupported(): boolean { return process.platform === 'win32' }

// Which applications this machine registers. Asked once per app run; the
// answer is what decides whether the office tools appear on the menu.
export function officeApps(): Probe | null { return probed ?? null }

export async function primeOffice(): Promise<Probe | null> {
  if (!officeSupported()) return null
  if (probed !== undefined) return probed
  try { probed = (await officeRequest('probe', {})) as Probe }
  catch { probed = null }
  return probed
}

async function scriptPath(): Promise<string> {
  const dir = join(app.getPath('userData'), 'office')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'office-host.ps1')
  // A byte-order mark: without it PowerShell 5 reads the file in the
  // system code page, and any character past ASCII breaks the parse.
  await writeFile(file, '﻿' + OFFICE_HOST_SCRIPT, 'utf8')
  return file
}

function fail(error: Error): void {
  const current = child
  child = undefined
  ready = undefined
  if (idle) clearTimeout(idle)
  idle = undefined
  for (const [id, request] of pending) { clearTimeout(request.timer); pending.delete(id); request.reject(error) }
  if (current) {
    stopping = new Promise<void>((resolve) => {
      if (current.exitCode !== null || current.signalCode !== null) { resolve(); return }
      current.once('exit', () => resolve())
      // Never kill Office itself: a dispatched COM call may already have applied.
      // Keep subsequent requests blocked until this worker has exited.
      try { current.kill() } catch { /* Keep the queue blocked until exit if termination fails. */ }
    })
  }
}

function touch(): void {
  if (idle) clearTimeout(idle)
  idle = setTimeout(() => fail(new Error('The office host closed after being idle.')), IDLE_MS)
  idle.unref()
}

async function start(): Promise<void> {
  if (ready) return ready
  if (!officeSupported()) throw new Error('Office automation is available on Windows.')
  const file = await scriptPath()
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child = proc
  proc.stderr.resume()
  ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { const error = new Error('The office host did not start in time.'); fail(error); reject(error) }, READY_MS)
    const gone = () => { clearTimeout(timer); const error = new Error('The office host closed.'); if (child === proc) fail(error); reject(error) }
    proc.once('error', gone)
    proc.once('exit', gone)
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (child !== proc || line.length > LINE_CAP) return
      let message: { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string; window?: string; name?: string }
      try { message = JSON.parse(line) as typeof message } catch { return }
      if (!message || typeof message !== 'object') return
      if (message.type === 'ready') { clearTimeout(timer); resolve(); return }
      if (!Number.isSafeInteger(message.id)) return
      const request = pending.get(message.id!)
      if (!request) return
      if (message.type === 'activity') {
        if (typeof message.window !== 'string' || !/^\d{1,20}$/.test(message.window) || typeof message.name !== 'string') { fail(new Error('Invalid application window')); return }
        void Promise.resolve().then(() => request.activity?.(message.window!, message.name!)).then(() => {
          if (child === proc && pending.get(message.id!) === request) proc.stdin.write(JSON.stringify({ activity: message.id }) + '\n', (error) => { if (error && child === proc) fail(error) })
        }).catch((error: unknown) => {
          if (child === proc && pending.get(message.id!) === request) fail(error instanceof Error ? error : new Error('Application activity could not start'))
        })
        return
      }
      clearTimeout(request.timer)
      pending.delete(message.id!)
      if (message.ok) request.resolve(message.result)
      else request.reject(new Error(typeof message.error === 'string' ? message.error : 'The office operation failed.'))
    })
  })
  return ready
}

// Office objects are single-threaded and one person's; requests take turns.
export function officeRequest(op: OfficeOp, args: Record<string, unknown>, signal?: AbortSignal, assertActive?: () => void, activity?: (window: string, name: string) => Promise<void>): Promise<unknown> {
  const run = async (): Promise<unknown> => {
    signal?.throwIfAborted()
    assertActive?.()
    await stopping
    await start()
    try { signal?.throwIfAborted(); assertActive?.() }
    catch (error) { fail(new Error('Office startup was cancelled before dispatch.')); throw error }
    const proc = child
    if (!proc) throw new Error('The office host is not running.')
    touch()
    const id = ++serial
    const line = JSON.stringify({ id, op, args, activity: !!activity }) + '\n'
    return new Promise<unknown>((resolve, reject) => {
      const stop = (reason: string) => fail(new Error(`${reason} The worker was stopped; changes may be partial. Read the document before continuing; do not replay the write.`))
      const timer = setTimeout(() => stop(`${op} did not finish in time.`), REQUEST_MS)
      const abort = () => stop('canceled')
      const guard = assertActive ? setInterval(() => { try { assertActive() } catch { stop('Computer control was stopped.') } }, 100) : undefined
      const clean = () => { if (guard) clearInterval(guard); signal?.removeEventListener('abort', abort) }
      pending.set(id, { resolve: (value) => { clean(); resolve(value) }, reject: (error) => { clean(); reject(error) }, timer, activity })
      signal?.addEventListener('abort', abort, { once: true })
      proc.stdin.write(line, (error) => { if (error) { signal?.removeEventListener('abort', abort); fail(error) } })
    })
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

export function closeOfficeHost(): void { fail(new Error('The office host closed.')) }
