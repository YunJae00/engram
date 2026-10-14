import { beforeEach, expect, it, vi } from 'vitest'
import type { Engine, EngineJobInput } from 'core'

const fake = vi.hoisted(() => ({
  profile: 'system',
  settings: { defaultEngine: 'codex', codexModel: 'default', aiSelections: { filing: { engine: 'codex', model: 'chosen' } } },
  jobs: [] as EngineJobInput[], verify: vi.fn(), mkdir: vi.fn(),
}))
vi.mock('electron', () => ({ app: { getPath: () => 'tmp/check-ai-profile' } }))
vi.mock('node:fs/promises', () => ({ mkdir: fake.mkdir }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => structuredClone(fake.settings) }))
vi.mock('../src/main/account-profiles.js', () => ({ activeAccountProfile: () => fake.profile }))
vi.mock('../src/main/vault.js', () => ({ resolveEngines: async () => [] }))
vi.mock('../src/main/setup-connection.js', () => ({ verifySetupConnection: fake.verify }))
vi.mock('core', async original => ({ ...await original<typeof import('core')>(), createEngine: (id: string) => ({
  id, detect: async () => ({ installed: true, loggedIn: true }),
  async *run(job: EngineJobInput) { fake.jobs.push(job); yield { type: 'result', text: 'OK' } },
}) }))
import { checkAISelection } from '../src/main/check-ai.js'

beforeEach(() => {
  vi.clearAllMocks(); fake.jobs = []; fake.profile = 'system'; fake.settings.aiSelections.filing.model = 'chosen'
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
})

it('checks the filing model in an empty app-owned folder, not the conversation default', async () => {
  fake.verify.mockImplementation(async (engine: Engine, workdir: string, _signal: unknown, current: () => Promise<void>) => {
    for await (const event of engine.run({ prompt: 'check', workdir } as EngineJobInput)) expect(event.type).toBe('result')
    await current()
  })
  await checkAISelection()
  expect(fake.jobs[0]?.model).toBe('chosen')
  expect(fake.jobs[0]?.workdir.replaceAll('\\', '/')).toBe('tmp/check-ai-profile/tmp/connection-check')
  expect(fake.mkdir).toHaveBeenCalledOnce()
})

it('shares concurrent checks and allows retry after failure', async () => {
  let fail!: (error: Error) => void
  fake.verify.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  const first = checkAISelection(), again = checkAISelection()
  expect(again).toBe(first)
  const rejected = expect(first).rejects.toThrow('limited')
  await vi.waitFor(() => expect(fake.verify).toHaveBeenCalledOnce())
  fail(new Error('limited')); await rejected
  fake.verify.mockResolvedValueOnce(undefined)
  await checkAISelection()
  expect(fake.verify).toHaveBeenCalledTimes(2)
})

it.each(['model', 'account'])('does not confirm stale selections after the %s changes', async change => {
  fake.verify.mockImplementation(async (_engine: Engine, _cwd: unknown, _signal: unknown, current: () => Promise<void>) => {
    if (change === 'model') fake.settings.aiSelections.filing.model = 'other'
    else fake.profile = 'work'
    await current()
  })
  await expect(checkAISelection()).rejects.toThrow('selection changed')
})
