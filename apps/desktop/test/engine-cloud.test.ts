import { describe, expect, it, vi } from 'vitest'
import { readAuthStatus, textOf } from '../src/main/engine-claude.js'
import { claudeBinary, cloudErrorKind, codexBinary, StatusCache, STATUS_TTL_MS, unpackedPath, withHelpersOnPath } from '../src/main/engine-cloud.js'
import { disableMcpOverrides, readLoginStatus, restoreOptionalFields, strictSchema } from '../src/main/engine-codex.js'
import { openStepSchema } from '../../../packages/core/src/agent-prompt.js'
import { tmpVaultRoot } from '../../../packages/core/test/helpers.js'
import { cometTools } from '../../../packages/core/src/comet-tools.js'
import { taskPlan } from '../../../packages/core/src/agent-plan.js'
import { initVault } from '../../../packages/core/src/vault.js'
import type { WebCourier } from '../../../packages/core/src/errand.js'
import { CodexAccount } from '../src/main/codex-account.js'

// The runtimes speak for themselves; these pin down how their words are read.
it('disables inherited MCP connections only through safely quoted invocation overrides', () => {
  expect(disableMcpOverrides(JSON.stringify([{ name: 'a.b', transport: { url: 'https://example.com' } }, { name: 'quoted"name', transport: { command: 'node' } }]))).toEqual(['mcp_servers={"a.b"={url="https://example.com",enabled=false},"quoted\\"name"={command="node",enabled=false}}'])
  expect(() => disableMcpOverrides('{}')).toThrow()
  expect(() => disableMcpOverrides('[{}]')).toThrow()
})

describe('readAuthStatus', () => {
  it('reads the runtime JSON, and treats anything else as not knowing', () => {
    expect(readAuthStatus('{"loggedIn":true,"email":"a@b.c"}')).toEqual({ installed: true, loggedIn: true, conclusive: true })
    expect(readAuthStatus('noise\n{"loggedIn":false}')).toEqual({ installed: true, loggedIn: false, conclusive: true })
    expect(readAuthStatus('command not found')).toEqual({ installed: true, loggedIn: false, conclusive: false })
  })
})

describe('readLoginStatus', () => {
  it('reads the runtime wording, and a dead process as not knowing', () => {
    expect(readLoginStatus('Not logged in\n', 0).loggedIn).toBe(false)
    expect(readLoginStatus('Not logged in\n', 0).conclusive).toBe(true)
    expect(readLoginStatus('Logged in using ChatGPT\n', 0).loggedIn).toBe(true)
    expect(readLoginStatus('', null).conclusive).toBe(false)
  })
})

describe('cloudErrorKind', () => {
  it('tells a sign-in problem from a limit from a crash', () => {
    expect(cloudErrorKind('Not logged in. Please run login.')).toBe('auth')
    expect(cloudErrorKind('HTTP 401 unauthorized')).toBe('auth')
    expect(cloudErrorKind('rate limit exceeded, retry later')).toBe('quota')
    expect(cloudErrorKind('Third-party apps now draw from your extra usage')).toBe('quota')
    expect(cloudErrorKind('segmentation fault')).not.toBe('auth')
  })
})

// The runtimes ship with the app as dependencies; this build must be able to
// find both for the platform it runs on, or the sign-in buttons are dead.
describe('bundled runtimes', () => {
  it('finds both runtimes for this platform', () => {
    expect(claudeBinary()).not.toBeNull()
    expect(codexBinary()).not.toBeNull()
  })
  it.skipIf(process.env['ENGRAM_CODEX_CATALOG_TEST'] !== '1')('reads the bundled runtime model catalog without creating a turn', async () => {
    const account = new CodexAccount(new AbortController().signal)
    try {
      const models = await account.models()
      expect(models.length).toBeGreaterThan(0)
      expect(models.every((row) => row.value.length > 0 && row.label.length > 0)).toBe(true)
      console.log('Runtime model catalog:', models.map((row) => row.label).join(', '))
    } finally { account.close() }
  }, 35000)
})

// Conclusive account probes are shared until expiry or sign-in invalidation.
describe('StatusCache', () => {
  it('does not reuse or cache an old account probe after sign-in changes', async () => {
    const cache = new StatusCache()
    let finish!: (value: { installed: boolean; loggedIn: boolean; conclusive: boolean }) => void
    const old = cache.read(() => new Promise((resolve) => { finish = resolve }))
    cache.forget()
    const fresh = vi.fn(async () => ({ installed: true, loggedIn: false, conclusive: true }))
    expect((await cache.read(fresh)).loggedIn).toBe(false)
    finish({ installed: true, loggedIn: true, conclusive: true })
    await old
    expect((await cache.read(fresh)).loggedIn).toBe(false)
    expect(fresh).toHaveBeenCalledTimes(1)
  })
  it('keeps a positive answer for a while and shares an in-flight probe', async () => {
    const cache = new StatusCache()
    let probes = 0
    const probe = async () => (probes++, { installed: true, loggedIn: true, conclusive: true })
    const [a, b] = await Promise.all([cache.read(probe, 1000), cache.read(probe, 1000)])
    expect(a.loggedIn && b.loggedIn).toBe(true)
    expect(probes).toBe(1)
    await cache.read(probe, 1000 + STATUS_TTL_MS - 1)
    expect(probes).toBe(1)
    await cache.read(probe, 1000 + STATUS_TTL_MS + 1)
    expect(probes).toBe(2)
  })
  it('shares conclusive signed-out probes until expiry or sign-in invalidation', async () => {
    const cache = new StatusCache()
    let probes = 0
    const probe = async () => (probes++, { installed: true, loggedIn: false, conclusive: true })
    await cache.read(probe, 1000)
    await cache.read(probe, 1001)
    expect(probes).toBe(1)
    const yes = async () => (probes++, { installed: true, loggedIn: true, conclusive: true })
    await cache.read(yes, 2000)
    cache.forget()
    await cache.read(yes, 2001)
    expect(probes).toBe(2)
  })
})

describe('withHelpersOnPath', () => {
  it('puts the helper folder first on the path, whatever the key is called', () => {
    const sep = process.platform === 'win32' ? '\\' : '/'
    const binary = `${sep}x${sep}vendor${sep}bin${sep}codex`
    const env = withHelpersOnPath(binary, { Path: 'a', HOME: 'h' })
    expect(env['Path']!.startsWith(`${sep}x${sep}vendor${sep}codex-path`)).toBe(true)
    expect(env['Path']!.endsWith('a')).toBe(true)
    expect(env['HOME']).toBe('h')
    expect(withHelpersOnPath(binary, {})['PATH']).toBe(`${sep}x${sep}vendor${sep}codex-path`)
  })
})

describe('textOf / unpackedPath', () => {
  it('joins the text blocks of an answer', () => {
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(textOf('plain')).toBe('plain')
    expect(textOf(null)).toBe('')
  })
  it('points a packed path at its unpacked twin', () => {
    const sep = process.platform === 'win32' ? '\\' : '/'
    expect(unpackedPath(`C:${sep}app${sep}app.asar${sep}node_modules${sep}x`)).toBe(`C:${sep}app${sep}app.asar.unpacked${sep}node_modules${sep}x`)
    expect(unpackedPath(`${sep}plain${sep}path`)).toBe(`${sep}plain${sep}path`)
  })
})

describe('the schema handed to the strict runtime', () => {
  it.skipIf(!process.env['ENGRAM_CODEX_SCHEMA_MODEL'])('accepts the optional argument schema in a live read-only turn', async () => {
    const { Codex } = await import('@openai/codex-sdk')
    const binary = codexBinary()
    expect(binary).toBeTruthy()
    const root = await tmpVaultRoot('codex-schema')
    const paths = await initVault(root, { git: false })
    const unavailable = async (): Promise<never> => { throw new Error('This schema probe must not execute tools') }
    const courier = new Proxy({} as WebCourier, { get: () => unavailable })
    const schema = openStepSchema([...cometTools({ paths, retrieve: unavailable, courier, runProcedure: unavailable }), taskPlan([]).tool])
    const thread = new Codex({ codexPathOverride: binary!, env: withHelpersOnPath(binary!) }).startThread({
      workingDirectory: root, model: process.env['ENGRAM_CODEX_SCHEMA_MODEL'],
      sandboxMode: 'read-only', approvalPolicy: 'never', skipGitRepoCheck: true, networkAccessEnabled: false, webSearchMode: 'disabled',
    })
    const result = await thread.run('Return tool answer with args.text equal to schema check passed. Set unused arguments to null. Do not use tools or read any files.', { outputSchema: strictSchema(schema), signal: AbortSignal.timeout(60_000) })
    expect(result.items.every(item => item.type === 'agent_message' || item.type === 'reasoning')).toBe(true)
    expect(restoreOptionalFields(JSON.parse(result.finalResponse), schema)).toEqual({ step: { tool: 'answer', args: { text: 'schema check passed' } } })
  }, 75_000)

  it('closes every object and drops a map-valued additionalProperties', () => {
    const strict = strictSchema({
      type: 'object',
      properties: {
        args: { type: 'object', required: ['slots'], properties: { slots: { type: 'object', additionalProperties: { type: 'string' } } } },
      },
      required: ['args'],
      additionalProperties: { type: 'string' },
    }) as { additionalProperties: boolean; properties: { args: { additionalProperties: boolean; properties: { slots: { additionalProperties: boolean } } } } }
    expect(strict.additionalProperties).toBe(false)
    expect(strict.properties.args.additionalProperties).toBe(false)
    expect(strict.properties.args.properties.slots.additionalProperties).toBe(false)
  })

  it('leaves an already-closed schema exactly closed', () => {
    const strict = strictSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }) as { additionalProperties: boolean }
    expect(strict.additionalProperties).toBe(false)
  })

  it('walks oneOf branches too', () => {
    const strict = strictSchema({ oneOf: [{ type: 'object', properties: {} }] }) as { oneOf: { additionalProperties: boolean }[] }
    expect(strict.oneOf[0]!.additionalProperties).toBe(false)
  })

  it('requires every nested argument while preserving omitted fields after decoding', () => {
    const argsSchema = { type: 'object', properties: {
      target: { type: 'string' },
      count: { type: 'integer' },
      mode: { type: 'string', enum: ['quick', 'full'] },
      explicit: { type: ['string', 'null'] },
      rows: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, selected: { type: 'boolean' } }, required: ['label'] } },
    }, required: ['target'] }
    const schema = openStepSchema([{ name: 'read_page', description: 'Read a page', argsSchema, run: async () => 'read' }])
    const strict = strictSchema(schema) as { properties: { step: { anyOf: { properties: { args: { required: string[]; properties: Record<string, { anyOf: unknown[] }> } } }[] } } }
    const args = strict.properties.step.anyOf[0]!.properties.args
    expect(args.required).toEqual(['target', 'count', 'mode', 'explicit', 'rows'])
    expect(args.properties.mode?.anyOf).toEqual([{ type: 'string', enum: ['quick', 'full'] }, { type: 'null' }])
    const inspect = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const value = node as Record<string, unknown>
      if (value['type'] === 'object') {
        expect(value['required']).toEqual(Object.keys(value['properties'] as object))
        expect(value['additionalProperties']).toBe(false)
      }
      Object.values(value).forEach(inspect)
    }
    inspect(strict)
    expect(restoreOptionalFields({ step: { tool: 'read_page', args: { target: 'Notes', count: null, mode: null, explicit: null, rows: [{ label: 'A', selected: null }, { label: 'B', selected: false }] } } }, schema))
      .toEqual({ step: { tool: 'read_page', args: { target: 'Notes', explicit: null, rows: [{ label: 'A' }, { label: 'B', selected: false }] } } })
    expect(restoreOptionalFields({ target: null, count: 0, explicit: null }, argsSchema)).toEqual({ target: null, count: 0, explicit: null })
    expect((argsSchema.properties.count as { type: string }).type).toBe('integer')
    expect(cloudErrorKind('invalid_json_schema: Missing text, status 400')).not.toBe('quota')
  })
})
