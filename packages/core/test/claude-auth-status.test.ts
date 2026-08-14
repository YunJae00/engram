import { describe, expect, it } from 'vitest'
import { claudeAuthStatus, parseAuthStatus, resolveLoggedIn } from '../src/engine/claude.js'

describe('parseAuthStatus', () => {
  it('reads the measured JSON shape', () => {
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}')).toBe(false)
    expect(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth","apiProvider":"firstParty"}')).toBe(true)
  })

  it('sees through ANSI colour codes and OSC title sequences', () => {
    // OSC title (ESC ] … BEL) then SGR colour runs (ESC [ … m) around the JSON —
    // what the CLI emits when it believes it is talking to a terminal. Written as
    // \u escapes on purpose: raw control bytes in a source file get eaten silently
    // by editors and the test would then pass while testing nothing.
    const noisy = '\u001B]0;claude\u0007\u001B[2m\u001B[32m{"loggedIn":true}\u001B[0m\n'
    expect(parseAuthStatus(noisy)).toBe(true)
    expect(parseAuthStatus('\u001B[31m{"loggedIn":false,"authMethod":"none"}\u001B[0m')).toBe(false)
  })

  it('finds the verdict even when log lines share the stream', () => {
    const mixed = ['[warn] update available', '{ "loggedIn": false, "authMethod": "none" }', ''].join('\n')
    expect(parseAuthStatus(mixed)).toBe(false)
  })

  // "Cannot ask" is NOT "logged out" — an old CLI that prints its usage text
  // must never be read as a logout, or the librarian is silently disabled on a
  // perfectly working machine.
  it('returns null for a legacy CLI that has no auth subcommand', () => {
    expect(parseAuthStatus('Unknown command: auth\nUsage: claude [options] [command]')).toBeNull()
    expect(parseAuthStatus("error: unknown option '--output-format'")).toBeNull()
  })

  it('returns null for empty, whitespace or unrelated JSON output', () => {
    expect(parseAuthStatus('')).toBeNull()
    expect(parseAuthStatus('   \n  ')).toBeNull()
    expect(parseAuthStatus('{"version":"1.2.3"}')).toBeNull()
  })

  it('does not mistake a non-boolean loggedIn for a verdict', () => {
    expect(parseAuthStatus('{"loggedIn":"yes"}')).toBeNull()
    expect(parseAuthStatus('{"loggedIn":null}')).toBeNull()
  })
})

describe('resolveLoggedIn — the file check is a pre-filter, the CLI is the authority', () => {
  it('says no with no token file, whatever the CLI says (it is not even asked)', () => {
    expect(resolveLoggedIn(false, null)).toBe(false)
    expect(resolveLoggedIn(false, true)).toBe(false)
  })

  it('lets the CLI overrule a token file that merely EXISTS', () => {
    // The exact bug: the token is on disk but expired and unrefreshable.
    expect(resolveLoggedIn(true, false)).toBe(false)
  })

  it('agrees when both agree', () => {
    expect(resolveLoggedIn(true, true)).toBe(true)
  })

  it('keeps the file answer when the CLI could not be asked', () => {
    expect(resolveLoggedIn(true, null)).toBe(true)
  })
})

describe('claudeAuthStatus', () => {
  // No claude required: a binary that does not exist is the "cannot ask" case,
  // and it must produce null rather than a false "logged out".
  it('returns null when the binary cannot be spawned at all', async () => {
    expect(await claudeAuthStatus('engram-no-such-binary-9c1f')).toBeNull()
  })
})
