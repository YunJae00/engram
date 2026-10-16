import { app, net, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renameWithRetry } from 'core'
import type { BrainConnectionDto, BrainConnectionInput, BrainConnectionProvider } from '../shared/types.js'
import { flog } from './flog.js'

interface StoredConnection { baseUrl: string; model: string; key: string; encrypted: boolean }
type Store = Partial<Record<BrainConnectionProvider, StoredConnection>>

export const CODEX_KEY_ENV = 'ENGRAM_CODEX_KEY'
const FILE = 'connections.json'
let cache: Store | null = null
let loading: Promise<Store> | null = null
let saving: Promise<unknown> = Promise.resolve()
const verified = new WeakMap<StoredConnection, number>()
export const connectionFetch: typeof fetch = (url, init) => net.fetch(url instanceof URL ? url.href : url, { ...init, redirect: 'error' })

const path = (): string => join(app.getPath('userData'), FILE)

function seal(key: string): { key: string; encrypted: boolean } {
  if (!safeStorage.isEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure key storage is unavailable. Sign in instead.')
  return { key: safeStorage.encryptString(key).toString('base64'), encrypted: true }
}
function open(stored: StoredConnection): string {
  if (!stored.encrypted) return ''
  try { return safeStorage.decryptString(Buffer.from(stored.key, 'base64')) } catch (error) { flog('connections', `could not decrypt a stored key: ${error instanceof Error ? error.message : String(error)}`); return '' }
}

export async function loadBrainConnections(): Promise<Store> {
  if (cache) return cache
  loading ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(path(), 'utf8')) as Store
      cache = Object.fromEntries(Object.entries(raw ?? {}).filter(([provider, value]) => ['claude', 'codex', 'decision'].includes(provider) && value && typeof value.baseUrl === 'string' && typeof value.key === 'string'))
    } catch { cache = {} }
    return cache
  })().finally(() => { loading = null })
  return loading
}

async function save(store: Store): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  const pending = `${path()}.${randomUUID()}.tmp`
  await writeFile(pending, JSON.stringify(store, null, 2), { mode: 0o600 })
  await renameWithRetry(pending, path())
  cache = store
}

// The connection as the runtime needs it, with the key in the clear; only the
// main process reads this, and only to hand it to the runtime's environment.
export function brainConnection(provider: BrainConnectionProvider): { baseUrl: string; model: string; key: string } | null {
  const stored = cache?.[provider]
  if (!stored) return null
  const key = open(stored)
  return key ? { baseUrl: stored.baseUrl, model: stored.model, key } : null
}

// What the settings screen may know: everything but the key itself.
export function brainConnectionDto(provider: BrainConnectionProvider): BrainConnectionDto | null {
  const stored = cache?.[provider]
  if (!stored) return null
  const key = open(stored)
  return { provider, baseUrl: stored.baseUrl, model: stored.model, keyHint: key.length > 8 ? `…${key.slice(-4)}` : '', usable: key.length > 0 }
}

const trimSlash = (url: string): string => url.trim().replace(/\/+$/, '')

export function validateConnectionInput(input: BrainConnectionInput): { baseUrl: string; model: string; key: string } {
  const baseUrl = trimSlash(typeof input.baseUrl === 'string' ? input.baseUrl : '')
  const key = typeof input.key === 'string' ? input.key.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(baseUrl) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s]*)?$/.test(baseUrl)) throw new Error('Enter the address as https://host/path (http is allowed only for localhost).')
  const url = new URL(baseUrl)
  if (url.username || url.password || url.search || url.hash) throw new Error('The address must not contain credentials, a query or a fragment.')
  if (!key || key.length > 512 || /\s/.test(key)) throw new Error('Enter the API key the address issued.')
  if (model.length > 200 || /\s/.test(model)) throw new Error('Enter a model ID without spaces, or leave it empty for the default.')
  return { baseUrl, model, key }
}

export function setBrainConnection(provider: BrainConnectionProvider, input: BrainConnectionInput): Promise<BrainConnectionDto> {
  const clean = validateConnectionInput(input)
  if (!clean.model) throw new Error('Enter the model ID to test this connection.')
  const sealed = seal(clean.key)
  const work = saving.then(async () => {
    const checked = await checkConnection(provider, clean)
    if (!checked.ok) throw new Error(checked.message ?? 'The model did not answer the connection test.')
    const store = { ...(await loadBrainConnections()), [provider]: { baseUrl: clean.baseUrl, model: clean.model, ...sealed } }
    await save(store)
    verified.set(store[provider]!, Date.now())
    flog('connections', `${provider}: model answered at ${new URL(clean.baseUrl).origin}`)
    return brainConnectionDto(provider)!
  })
  saving = work.catch(() => undefined)
  return work
}

export async function clearBrainConnection(provider: BrainConnectionProvider): Promise<void> {
  const work = saving.then(async () => {
    const store = { ...(await loadBrainConnections()) }
    delete store[provider]
    await save(store)
    flog('connections', `${provider}: key connection removed`)
  })
  saving = work.catch(() => undefined)
  return work
}

// Environment for a runtime reached by key. Claude Code validates an
// ANTHROPIC_API_KEY against Anthropic itself, so a gateway takes the token
// variable; Codex names its key variable in the provider it is given.
export function connectionEnvironment(provider: 'claude' | 'codex'): Record<string, string> {
  const connection = brainConnection(provider)
  if (!connection) return {}
  if (provider === 'claude') return { ANTHROPIC_BASE_URL: connection.baseUrl, ANTHROPIC_AUTH_TOKEN: connection.key, ...(connection.model ? { ANTHROPIC_MODEL: connection.model } : {}) }
  return { [CODEX_KEY_ENV]: connection.key }
}

// Codex takes its provider as config overrides; the base URL stops where the
// runtime appends /responses itself.
export function codexProviderOverrides(): string[] {
  const connection = brainConnection('codex')
  if (!connection) return []
  return [
    'model_provider="engram"',
    'model_providers.engram.name="Engram connection"',
    `model_providers.engram.base_url=${JSON.stringify(connection.baseUrl)}`,
    `model_providers.engram.env_key="${CODEX_KEY_ENV}"`,
    'model_providers.engram.wire_api="responses"',
    ...(connection.model ? [`model=${JSON.stringify(connection.model)}`] : []),
  ]
}

// Whether the address answers the key: the model list is the one call every
// such API has, and 401 is its way of saying the key is wrong.
export async function probeConnection(provider: 'claude' | 'codex', fetchImpl: typeof fetch = connectionFetch): Promise<{ ok: boolean; status: number; message?: string }> {
  const connection = brainConnection(provider)
  if (!connection) return { ok: false, status: 0, message: 'No key connection.' }
  const stored = cache?.[provider]
  if (fetchImpl === connectionFetch && stored && Date.now() - (verified.get(stored) ?? 0) < 10 * 60_000) return { ok: true, status: 200 }
  const result = await checkConnection(provider, connection, fetchImpl)
  if (result.ok && stored && cache?.[provider] === stored) verified.set(stored, Date.now())
  return result
}

async function checkConnection(provider: BrainConnectionProvider, connection: { baseUrl: string; key: string; model: string }, fetchImpl: typeof fetch = connectionFetch): Promise<{ ok: boolean; status: number; message?: string }> {
  const url = provider === 'decision' ? connection.baseUrl : `${connection.baseUrl}${provider === 'claude' ? '/v1/messages' : '/responses'}`
  const headers: Record<string, string> = provider === 'claude' ? { 'x-api-key': connection.key, authorization: `Bearer ${connection.key}`, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${connection.key}` }
  const body = provider === 'claude' ? { model: connection.model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply OK.' }] } : provider === 'codex' ? { model: connection.model, input: 'Reply OK.', store: false } : { model: connection.model, state: 'Connection test. Choose ready.', questions: { next: { type: 'choice', instructions: 'Choose ready.', criteria: { ready: 'Ready', blocked: 'Not ready' } } } }
  try {
    const response = await fetchImpl(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30_000) })
    if (!response.ok) return { ok: false, status: response.status, message: response.status === 401 || response.status === 403 ? 'The address did not accept this key.' : `The model answered ${response.status}.` }
    const result = await response.json() as { type?: string; content?: { type: string; text?: string }[]; status?: string; output?: { content?: { type: string; text?: string }[] }[]; answers?: { next?: { choice?: string } } }
    const ok = provider === 'decision' ? result.answers?.next?.choice === 'ready' : provider === 'claude' ? result.type === 'message' && result.content?.some(item => item.type === 'text' && !!item.text) : result.status === 'completed' && result.output?.some(item => item.content?.some(part => part.type === 'output_text' && !!part.text))
    return ok ? { ok: true, status: response.status } : { ok: false, status: response.status, message: 'The model did not return a completed answer.' }
  } catch { return { ok: false, status: 0, message: 'Could not test the model. Check the address and try again.' } }
}

// The models the address offers, in the shape the picker takes.
export async function connectionModels(provider: 'claude' | 'codex', fetchImpl: typeof fetch = connectionFetch): Promise<{ value: string; label: string; detail: string }[]> {
  const connection = brainConnection(provider)
  if (!connection) return []
  const url = provider === 'claude' ? `${connection.baseUrl}/v1/models` : `${connection.baseUrl}/models`
  const headers: Record<string, string> = provider === 'claude' ? { 'x-api-key': connection.key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${connection.key}` }
  try {
    const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (!response.ok) return [{ value: connection.model, label: connection.model, detail: 'Connected model' }]
    const body = await response.json() as { data?: { id?: unknown; display_name?: unknown; owned_by?: unknown }[] }
    const rows = (body.data ?? []).filter((row) => typeof row.id === 'string' && (row.id as string).length <= 200)
    return rows.map((row) => ({ value: row.id as string, label: typeof row.display_name === 'string' ? row.display_name : row.id as string, detail: typeof row.owned_by === 'string' ? row.owned_by : connection.baseUrl }))
  } catch { return [{ value: connection.model, label: connection.model, detail: 'Connected model' }] }
}
