import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { codexBinary, withHelpersOnPath } from './engine-cloud.js'
import type { ModelChoiceDto } from '../shared/types.js'

// Account and catalog requests only. No threads, turns, tools or credentials
// are exposed to the renderer; the bundled runtime owns authentication.
export class CodexAccount {
  private child: ChildProcessWithoutNullStreams
  private serial = 0
  private failure?: Error
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private notification?: (method: string, params: Record<string, unknown>) => void
  private onClose?: (error: Error) => void
  private timer: ReturnType<typeof setTimeout>
  private abort: () => void
  private ready: Promise<unknown>

  constructor(private signal: AbortSignal, timeout = 30_000) {
    signal.throwIfAborted()
    const binary = codexBinary()
    if (!binary) throw new Error('The ChatGPT runtime is not part of this build.')
    this.child = spawn(binary, ['app-server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: withHelpersOnPath(binary) })
    this.abort = () => this.close(new Error('Sign-in cancelled.'))
    this.timer = setTimeout(() => this.close(new Error('ChatGPT did not respond in time. Try again.')), timeout)
    signal.addEventListener('abort', this.abort, { once: true })
    this.child.stderr.resume()
    this.child.on('error', (error) => this.close(error))
    this.child.on('exit', () => this.close(new Error('The ChatGPT connection closed. Try again.')))
    this.child.stdin.on('error', (error) => this.close(error))
    createInterface({ input: this.child.stdout }).on('error', (error) => this.close(error)).on('line', (line) => {
      if (this.failure) return
      if (line.length > 1_048_576) { this.close(new Error('The ChatGPT response was too large.')); return }
      try {
        const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
        if (!message || typeof message !== 'object') return
        const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
        if (pending) {
          this.pending.delete(message.id!)
          if (message.error) pending.reject(new Error(message.error.message ?? 'The ChatGPT request failed.'))
          else pending.resolve(message.result)
        } else if (typeof message.method === 'string' && message.params && typeof message.params === 'object') {
          this.notification?.(message.method, message.params)
        }
      } catch { this.close(new Error('The ChatGPT runtime returned an invalid response.')) }
    })
    this.ready = this.send('initialize', { clientInfo: { name: 'engram', title: 'Engram', version: '1.0' } }).then(() => {
      this.child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    })
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure)
    const id = ++this.serial
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  async models(): Promise<ModelChoiceDto[]> {
    await this.ready
    const rows = new Map<string, ModelChoiceDto>()
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.send('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }) as { data?: unknown[]; nextCursor?: string | null }
      if (!Array.isArray(page?.data)) throw new Error('ChatGPT did not return a model list.')
      for (const item of page.data) {
        if (!item || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        if (row['hidden'] === true || typeof row['model'] !== 'string' || !row['model'].trim()) continue
        rows.set(row['model'], { value: row['model'], label: typeof row['displayName'] === 'string' ? row['displayName'] : row['model'], detail: typeof row['description'] === 'string' ? row['description'] : '' })
      }
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined
      if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new Error('The ChatGPT model list did not finish.')
      if (cursor) seen.add(cursor)
    } while (cursor)
    return [...rows.values()]
  }

  async login(onUrl: (url: string) => void): Promise<void> {
    await this.ready
    await new Promise<void>((resolve, reject) => {
      this.onClose = reject
      let loginId: string | undefined
      let early: Record<string, unknown> | undefined
      const complete = (params: Record<string, unknown>) => {
        if (!loginId) { early = params; return }
        if (params['loginId'] !== loginId) return
        if (params['success'] === true) resolve()
        else reject(new Error(typeof params['error'] === 'string' ? params['error'] : 'Sign-in did not complete.'))
      }
      this.notification = (method, params) => { if (method === 'account/login/completed') complete(params) }
      void this.send('account/login/start', { type: 'chatgpt' }).then((value) => {
        const result = value as { loginId?: string; authUrl?: string }
        if (typeof result?.loginId !== 'string' || typeof result.authUrl !== 'string') throw new Error('ChatGPT did not return a sign-in link.')
        loginId = result.loginId
        onUrl(result.authUrl)
        if (early) complete(early)
      }).catch(reject)
    })
  }

  close(error = new Error('The ChatGPT account request ended.')): void {
    if (this.failure) return
    this.failure = error
    clearTimeout(this.timer)
    this.signal.removeEventListener('abort', this.abort)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.onClose?.(error)
    this.child.kill()
  }
}

let known: ModelChoiceDto[] = []
let fetching: Promise<ModelChoiceDto[]> | undefined
let generation = 0
export function forgetCodexModels(): void { generation++; known = []; fetching = undefined }
export function fetchCodexModels(): Promise<ModelChoiceDto[]> {
  if (known.length) return Promise.resolve(known)
  if (fetching) return fetching
  const at = generation
  const pending = (async () => {
    const account = new CodexAccount(new AbortController().signal)
    try {
      const rows = await account.models()
      if (generation === at) known = rows
      return generation === at ? rows : []
    } finally { account.close() }
  })().finally(() => { if (fetching === pending) fetching = undefined })
  fetching = pending
  return pending
}
