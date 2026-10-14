import { beforeEach, expect, it, vi } from 'vitest'
import { engineCwd, type Engine, type EngineJobInput } from 'core'

const fake = vi.hoisted(() => ({ ok: vi.fn(), failure: vi.fn(), forget: vi.fn(), profile: 'system' }))
vi.mock('../src/main/engine-health.js', () => ({ markEngineOk: fake.ok, noteEngineFailure: fake.failure }))
vi.mock('../src/main/engine-cloud.js', () => ({ cloudEngine: () => ({ forgetStatus: fake.forget }) }))
vi.mock('../src/main/account-profiles.js', () => ({ activeAccountProfile: () => fake.profile }))
import { verifySetupConnection } from '../src/main/setup-connection.js'

const cwd = engineCwd({ workspace: 'tmp/connection-fixture', privateDir: '' })
beforeEach(() => { vi.clearAllMocks(); fake.profile = 'system' })
function fixture(detection = { installed: true, loggedIn: true, conclusive: true }, outcome = 'ok') {
  const jobs: EngineJobInput[] = []
  const engine: Engine = { id: 'codex', detect: vi.fn(async () => detection), async *run(job) {
    jobs.push(job)
    if (outcome === 'auth' || outcome === 'quota') yield { type: 'error', kind: outcome, message: 'Fixture rejection' }
    else yield { type: 'result', text: outcome === 'empty' ? '' : 'OK' }
  } }
  return { engine, jobs }
}

it('requires a live response without sending user content or enabling tools', async () => {
  const { engine, jobs } = fixture()
  await verifySetupConnection(engine, cwd)
  expect(fake.forget).toHaveBeenCalledOnce()
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ workdir: cwd, disallowTools: true, requireToolIsolation: true, maxTokens: 8, timeoutMs: 60000 })
  expect(jobs[0]!.prompt).toBe('Connection check only. Reply with OK. Do not use tools or read files.')
  expect(fake.ok).toHaveBeenCalledWith('codex', 'system')
})

it.each([
  { installed: false, loggedIn: false, conclusive: true },
  { installed: true, loggedIn: false, conclusive: true },
  { installed: true, loggedIn: true, conclusive: false },
])('never proceeds with absent, signed-out or unknown authentication', async detection => {
  const { engine, jobs } = fixture(detection)
  await expect(verifySetupConnection(engine, cwd)).rejects.toThrow('not verified')
  expect(jobs).toHaveLength(0); expect(fake.ok).not.toHaveBeenCalled()
})

it.each(['auth', 'quota', 'empty'])('rejects unusable live requests rather than trusting local sign-in (%s)', async outcome => {
  const { engine } = fixture(undefined, outcome)
  await expect(verifySetupConnection(engine, cwd)).rejects.toThrow(outcome === 'auth' ? 'Sign in again' : outcome === 'quota' ? 'usage limit' : 'did not answer')
  expect(fake.ok).not.toHaveBeenCalled(); expect(fake.failure).toHaveBeenCalledOnce()
})

it('does not spend usage when canceled before the check', async () => {
  const { engine, jobs } = fixture()
  await expect(verifySetupConnection(engine, cwd, AbortSignal.abort())).rejects.toThrow()
  expect(engine.detect).not.toHaveBeenCalled(); expect(jobs).toHaveLength(0)
})

it('stops waiting even if a broken runtime ignores cancellation', async () => {
  const { engine } = fixture()
  engine.run = vi.fn(async function* () { await new Promise<void>(() => undefined); yield { type: 'result', text: 'late' } })
  const abort = new AbortController()
  const pending = verifySetupConnection(engine, cwd, abort.signal)
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(engine.run).toHaveBeenCalledOnce())
  abort.abort(); await rejected
  expect(fake.ok).not.toHaveBeenCalled()
  expect(fake.failure).not.toHaveBeenCalled()
})

it('does not confirm an account that changed while its request was running', async () => {
  const { engine } = fixture()
  engine.run = async function* () { fake.profile = 'other'; yield { type: 'result', text: 'OK' } }
  await expect(verifySetupConnection(engine, cwd)).rejects.toThrow('not ready')
  expect(fake.ok).not.toHaveBeenCalled()
})
