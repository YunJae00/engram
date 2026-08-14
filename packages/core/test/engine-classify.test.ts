import { describe, expect, it } from 'vitest'
import { classifyEngineError } from '../src/engine/classify.js'
import {
  AuthError,
  collectResult,
  EngineCallError,
  QuotaError,
  type Engine,
  type EngineCwd,
  type EngineEvent,
} from '../src/engine/types.js'

const CWD = 'workspace' as EngineCwd

function engineOf(events: EngineEvent[]): Engine {
  return {
    id: 'mock',
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() {
      yield* events
    },
  }
}

// Four failures needed four sentences and got one opaque string. The whole
// point of classification is that a user over their usage limit is never told
// to re-authenticate, and a dead token is never retried 2N times in silence.
describe('classifyEngineError', () => {
  it('reads a usage limit as quota, whatever wording the CLI used', () => {
    expect(classifyEngineError('Error: 429 Too Many Requests')).toBe('quota')
    expect(classifyEngineError('rate_limit_error: please slow down')).toBe('quota')
    expect(classifyEngineError('You have reached your usage limit for this 5-hour window')).toBe('quota')
    expect(classifyEngineError('quota exceeded')).toBe('quota')
  })

  it('reads a dead or missing login as auth', () => {
    expect(classifyEngineError('Invalid API key · Please run /login')).toBe('auth')
    expect(classifyEngineError('claude exited 1: Not logged in', 1)).toBe('auth')
    expect(classifyEngineError('HTTP 401 Unauthorized')).toBe('auth')
    expect(classifyEngineError('OAuth token expired — session expired')).toBe('auth')
  })

  it('reads DNS/TCP/proxy/TLS trouble as network', () => {
    expect(classifyEngineError('getaddrinfo ENOTFOUND api.anthropic.com')).toBe('network')
    expect(classifyEngineError('connect ECONNREFUSED 127.0.0.1:8080')).toBe('network')
    expect(classifyEngineError('unable to verify the first certificate')).toBe('network')
    expect(classifyEngineError('fetch failed')).toBe('network')
  })

  it('reads a call WE ended for slowness as timeout, not crash (RELY-3)', () => {
    // A hang gets its own sentence and its own response: retry next run.
    expect(classifyEngineError('claude exited null: [engram] timed out after 300000ms', null)).toBe('timeout')
    expect(classifyEngineError('[engram] stalled: no output for 120000ms')).toBe('timeout')
    expect(classifyEngineError('job timeout after 300000ms')).toBe('timeout')
  })

  it('reads a dead or empty process as crash', () => {
    expect(classifyEngineError('[claude] empty engine result')).toBe('crash')
    expect(classifyEngineError("'claude' is not recognized as an internal or external command")).toBe('crash')
    expect(classifyEngineError('claude exited 1: something opaque', 1)).toBe('crash')
  })

  // A non-zero exit with unreadable stderr is still a crash — reporting it as
  // "unknown" would render as a shrug with no action attached.
  it('falls back to the exit code before giving up', () => {
    expect(classifyEngineError('', 1)).toBe('crash')
    expect(classifyEngineError('something odd happened')).toBe('unknown')
    expect(classifyEngineError('something odd happened', 0)).toBe('unknown')
  })

  // Precedence matters: a 429 body often also says "please try again", and an
  // auth failure often arrives over a socket. The most actionable wins.
  it('prefers quota over auth and auth over network when both appear', () => {
    expect(classifyEngineError('401 unauthorized: rate limit exceeded')).toBe('quota')
    expect(classifyEngineError('fetch failed: 403 unauthorized')).toBe('auth')
  })
})

describe('collectResult carries the kind through as a typed error', () => {
  it('turns a quota event into QuotaError', async () => {
    const engine = engineOf([{ type: 'error', message: 'usage limit reached', kind: 'quota' }])
    await expect(collectResult(engine, { prompt: '', workdir: CWD })).rejects.toBeInstanceOf(QuotaError)
  })

  it('turns an auth event into AuthError — which the runner must not retry', async () => {
    const engine = engineOf([{ type: 'error', message: 'Please run /login', kind: 'auth' }])
    await expect(collectResult(engine, { prompt: '', workdir: CWD })).rejects.toBeInstanceOf(AuthError)
  })

  it('classifies the message when an engine emits a bare error event', async () => {
    const engine = engineOf([{ type: 'error', message: 'HTTP 401 Unauthorized' }])
    await expect(collectResult(engine, { prompt: '', workdir: CWD })).rejects.toBeInstanceOf(AuthError)
  })

  it('keeps network and crash distinguishable instead of flattening them', async () => {
    const net = engineOf([{ type: 'error', message: 'getaddrinfo EAI_AGAIN', kind: 'network' }])
    await expect(collectResult(net, { prompt: '', workdir: CWD })).rejects.toMatchObject({ kind: 'network' })
    const empty = engineOf([{ type: 'result', text: '   ' }])
    await expect(collectResult(empty, { prompt: '', workdir: CWD })).rejects.toMatchObject({ kind: 'crash' })
  })

  it('still throws an EngineCallError for an unrecognisable failure', async () => {
    const engine = engineOf([{ type: 'error', message: 'weird' }])
    await expect(collectResult(engine, { prompt: '', workdir: CWD })).rejects.toBeInstanceOf(EngineCallError)
  })
})
