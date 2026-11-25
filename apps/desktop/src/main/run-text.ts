import type { EngineDetection } from 'core'
import { ProcessClient } from './process-client.js'

export interface CloudLoginOptions { signal?: AbortSignal; onUrl?: (url: string) => void }

export interface RunText {
  code: number | null
  out: string
  err: string
}

export function runText(binary: string, args: string[], timeoutMs: number, env?: Record<string, string>, login?: CloudLoginOptions): Promise<RunText> {
  login?.signal?.throwIfAborted()
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      login?.signal?.removeEventListener('abort', cancel)
      resolve({ code, out, err })
    }
    let child: ProcessClient
    try {
      child = new ProcessClient(binary, args, { env })
      child.stdin.end()
    } catch (error) {
      resolve({ code: null, out: '', err: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    const cancel = (): void => { child.kill(); finish(null) }
    login?.signal?.addEventListener('abort', cancel, { once: true })
    const receive = (stream: 'out' | 'err') => (chunk: Buffer): void => {
      const next = (stream === 'out' ? out : err) + chunk.toString()
      if (stream === 'out') out = next.slice(-65536)
      else err = next.slice(-65536)
      if (login?.onUrl) for (const url of chunk.toString().match(/https:\/\/[\w./?=&%+~:#@!-]+/g) ?? []) login.onUrl(url)
    }
    child.stdout?.on('data', receive('out'))
    child.stderr?.on('data', receive('err'))
    child.on('error', (error) => {
      err += error.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

export function commandText(result: RunText): string {
  return `${result.out ?? ''}${result.err ?? ''}`
}

export const LOGIN_TIMEOUT_MS = 5 * 60_000
export const STATUS_TIMEOUT_MS = 15_000
export const STATUS_TTL_MS = 60_000

export class StatusCache {
  private probing: Promise<EngineDetection> | null = null
  private known: { at: number; detection: EngineDetection } | null = null
  private generation = 0

  async read(probe: () => Promise<EngineDetection>, now = Date.now()): Promise<EngineDetection> {
    if (this.known && this.known.detection.installed && this.known.detection.conclusive !== false && now - this.known.at < STATUS_TTL_MS) return this.known.detection
    if (this.probing) return this.probing
    const generation = this.generation
    const pending = probe().then(detection => {
      if (generation !== this.generation) return this.known?.detection ?? { installed: detection.installed, loggedIn: false, conclusive: false }
      this.known = { at: now, detection }
      return detection
    }).finally(() => {
      if (this.probing === pending) this.probing = null
    })
    this.probing = pending
    return pending
  }

  forget(): void {
    this.known = null
    this.probing = null
    this.generation++
  }

  set(detection: EngineDetection, now = Date.now()): void {
    this.forget()
    this.known = { at: now, detection }
  }
}
