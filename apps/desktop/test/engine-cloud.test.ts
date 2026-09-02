import { describe, expect, it } from 'vitest'
import { readAuthStatus, textOf } from '../src/main/engine-claude.js'
import { claudeBinary, cloudErrorKind, codexBinary, StatusCache, STATUS_TTL_MS, unpackedPath, withHelpersOnPath } from '../src/main/engine-cloud.js'
import { readLoginStatus, strictSchema } from '../src/main/engine-codex.js'

// The runtimes speak for themselves; these pin down how their words are read.
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
})

// Detection is asked constantly; a sign-in seen a minute ago is not asked
// again, a probe in flight is shared, and a "not signed in" is re-asked.
describe('StatusCache', () => {
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
  it('asks again after a negative answer, and after forget', async () => {
    const cache = new StatusCache()
    let probes = 0
    const probe = async () => (probes++, { installed: true, loggedIn: false, conclusive: true })
    await cache.read(probe, 1000)
    await cache.read(probe, 1001)
    expect(probes).toBe(2)
    const yes = async () => (probes++, { installed: true, loggedIn: true, conclusive: true })
    await cache.read(yes, 2000)
    cache.forget()
    await cache.read(yes, 2001)
    expect(probes).toBe(4)
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
  it('closes every object and drops a map-valued additionalProperties', () => {
    const strict = strictSchema({
      type: 'object',
      properties: {
        args: { type: 'object', properties: { slots: { type: 'object', additionalProperties: { type: 'string' } } } },
      },
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
})
