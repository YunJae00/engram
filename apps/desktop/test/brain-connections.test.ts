import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ dir: '', encryption: true, fetch: vi.fn(), profile: 'system' }))
vi.mock('../src/main/account-profiles.js', () => ({ activeAccountProfile: () => fake.profile }))
vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  net: { fetch: fake.fetch },
  safeStorage: {
    isEncryptionAvailable: () => fake.encryption,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, ''),
  },
}))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { brainConnection, brainConnectionDto, clearBrainConnection, codexProviderOverrides, connectionEnvironment, connectionModels, loadBrainConnections, probeConnection, setBrainConnection, validateConnectionInput } from '../src/main/brain-connections.js'

beforeEach(async () => {
  fake.dir = await mkdtemp(join(tmpdir(), 'engram-connections-')); fake.encryption = true; fake.profile = 'system'
  fake.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }], answers: { next: { choice: 'ready' } } })))
})
afterEach(async () => { fake.profile = 'system'; for (const provider of ['claude', 'codex', 'decision'] as const) await clearBrainConnection(provider); await rm(fake.dir, { recursive: true, force: true }) })

describe('a brain reached by key', () => {
  it('keeps the key sealed on disk and hands the screen only its last letters', async () => {
    const dto = await setBrainConnection('claude', { baseUrl: 'https://gateway.example/v1/gateway/claude/', key: 'sk-test-abcd1234', model: 'claude-sonnet-5' })
    expect(dto).toEqual({ provider: 'claude', baseUrl: 'https://gateway.example/v1/gateway/claude', model: 'claude-sonnet-5', keyHint: '…1234', usable: true })
    const file = await readFile(join(fake.dir, 'connections.json'), 'utf8')
    expect(file).not.toContain('sk-test-abcd1234')
    expect(JSON.parse(file).claude).toMatchObject({ encrypted: true })
    expect(brainConnection('claude')).toEqual({ baseUrl: 'https://gateway.example/v1/gateway/claude', model: 'claude-sonnet-5', key: 'sk-test-abcd1234' })
    expect(brainConnectionDto('codex')).toBeNull()
  })

  it('refuses addresses and keys it cannot use', () => {
    expect(() => validateConnectionInput({ baseUrl: 'ftp://x', key: 'k', model: '' })).toThrow(/https:\/\//)
    expect(() => validateConnectionInput({ baseUrl: 'http://gateway.example', key: 'k', model: '' })).toThrow(/localhost/)
    expect(() => validateConnectionInput({ baseUrl: 'https://gateway.example', key: '', model: '' })).toThrow(/API key/)
    expect(() => validateConnectionInput({ baseUrl: 'https://gateway.example', key: 'k', model: 'two words' })).toThrow(/model ID/)
    expect(validateConnectionInput({ baseUrl: 'http://localhost:4000/v1/', key: 'k', model: '' })).toEqual({ baseUrl: 'http://localhost:4000/v1', key: 'k', model: '' })
  })

  it('gives each runtime the variables and overrides it reads a key from', async () => {
    expect(connectionEnvironment('claude')).toEqual({})
    expect(codexProviderOverrides()).toEqual([])
    await setBrainConnection('claude', { baseUrl: 'https://gateway.example/claude', key: 'tok', model: 'claude-sonnet-5' })
    expect(connectionEnvironment('claude')).toEqual({ ANTHROPIC_BASE_URL: 'https://gateway.example/claude', ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_MODEL: 'claude-sonnet-5' })
    await setBrainConnection('codex', { baseUrl: 'https://gateway.example/v1/gateway', key: 'ck', model: 'gpt-5.6-terra' })
    expect(connectionEnvironment('codex')).toEqual({ ENGRAM_CODEX_KEY: 'ck' })
    expect(codexProviderOverrides()).toEqual([
      'model_provider="engram"', 'model_providers.engram.name="Engram connection"', 'model_providers.engram.base_url="https://gateway.example/v1/gateway"',
      'model_providers.engram.env_key="ENGRAM_CODEX_KEY"', 'model_providers.engram.wire_api="responses"', 'model="gpt-5.6-terra"',
    ])
  })

  it('checks the key against the address and lists the models it offers', async () => {
    await setBrainConnection('claude', { baseUrl: 'https://gateway.example/claude', key: 'tok', model: 'claude-sonnet-5' })
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers })
      return new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }], data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }, { id: 'gpt-5.6-terra' }] }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await probeConnection('claude', fetchImpl)).toEqual({ ok: true, status: 200 })
    expect(calls[0]).toEqual({ url: 'https://gateway.example/claude/v1/messages', headers: { 'x-api-key': 'tok', authorization: 'Bearer tok', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } })
    expect(await connectionModels('claude', fetchImpl)).toEqual([
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', detail: 'https://gateway.example/claude' },
      { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra', detail: 'https://gateway.example/claude' },
    ])
    const denied = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    expect(await probeConnection('claude', denied)).toMatchObject({ ok: false, status: 401, message: expect.stringContaining('did not accept') })
    const down = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    expect(await probeConnection('claude', down)).toMatchObject({ ok: false, status: 0 })
  })

  it('refuses plaintext fallback without changing an existing connection', async () => {
    await setBrainConnection('decision', { baseUrl: 'https://gateway.example/decisions', key: 'original', model: 'jev-latest' })
    fake.encryption = false
    expect(() => setBrainConnection('decision', { baseUrl: 'https://gateway.example/decisions', key: 'replacement', model: 'jev-latest' })).toThrow(/Secure key storage/)
    const store = await loadBrainConnections()
    expect(store.decision).toMatchObject({ encrypted: true })
    expect(brainConnection('decision')?.key).toBe('original')
  })

  it('rejects credentials and query tokens in addresses', () => {
    for (const baseUrl of ['https://key@host.example', 'https://host.example?token=secret', 'https://host.example/#secret']) expect(() => validateConnectionInput({ baseUrl, key: 'k', model: 'm' })).toThrow()
  })

  it('requires a completed model answer, not an HTTP success or a model catalogue', async () => {
    fake.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] })))
    await expect(setBrainConnection('codex', { baseUrl: 'https://gateway.example/v1', key: 'k', model: 'm' })).rejects.toThrow(/completed answer/)
    expect(brainConnection('codex')).toBeNull()
    expect(fake.fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', method: 'POST' })
  })

  it('serializes saves so different provider connections cannot overwrite each other', async () => {
    await Promise.all(['claude', 'codex', 'decision'].map(provider => setBrainConnection(provider as 'claude', { baseUrl: 'https://gateway.example/v1', key: 'k', model: 'm' })))
    expect(Object.keys(JSON.parse(await readFile(join(fake.dir, 'connections.json'), 'utf8'))).sort()).toEqual(['claude', 'codex', 'decision'])
  })
  it('never hands one account\'s key or endpoint to another account', async () => {
    await setBrainConnection('codex', { baseUrl: 'https://gateway.example/v1', key: 'company-key', model: 'company-model' })
    fake.profile = 'personal'
    expect(brainConnection('codex')).toBeNull()
    expect(brainConnectionDto('codex')).toBeNull()
    expect(connectionEnvironment('codex')).toEqual({})
    expect(codexProviderOverrides()).toEqual([])
    expect(await probeConnection('codex')).toMatchObject({ ok: false, message: 'No key connection.' })
    await clearBrainConnection('codex')
    await expect(setBrainConnection('codex', { baseUrl: 'https://other.example/v1', key: 'personal-key', model: 'personal-model' })).rejects.toThrow(/another account/)
    expect(brainConnection('codex', 'system')?.baseUrl).toBe('https://gateway.example/v1')
    expect(connectionEnvironment('codex', 'personal')).toEqual({})
    expect(connectionEnvironment('codex', 'system')).toEqual({ ENGRAM_CODEX_KEY: 'company-key' })
  })
  it('does not save a connection if the selected account changes during its test', async () => {
    fake.fetch.mockImplementationOnce(async () => { fake.profile = 'other'; return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] })) })
    await expect(setBrainConnection('codex', { baseUrl: 'https://gateway.example/v1', key: 'k', model: 'm' })).rejects.toThrow(/selected account changed/)
    expect(brainConnection('codex', 'system')).toBeNull()
  })
})
