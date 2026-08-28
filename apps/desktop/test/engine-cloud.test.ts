import { describe, expect, it } from 'vitest'
import { readAuthStatus, textOf } from '../src/main/engine-claude.js'
import { claudeBinary, cloudErrorKind, codexBinary, unpackedPath } from '../src/main/engine-cloud.js'
import { readLoginStatus } from '../src/main/engine-codex.js'

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
