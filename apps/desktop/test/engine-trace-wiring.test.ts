import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { EngineCwd, ToolSessionJob } from 'core'

const built = vi.hoisted(() => ({ engines: [] as object[] }))
vi.mock('electron', () => ({ app: { getPath: () => `${process.cwd()}/tmp/trace-wiring-missing` }, net: {} }))
vi.mock('../src/main/account-profiles.js', () => ({ activeAccountProfile: () => 'default' }))
vi.mock('../src/main/claude-runtime.js', () => ({ installedClaudeBinary: () => null, loadClaudeSdk: async () => ({}), claudeSessionStarted: () => {}, afterFirstClaudeSession: async () => undefined }))
vi.mock('../src/main/engine-codex.js', () => ({ CodexEngine: class {} }))
vi.mock('../src/main/engine-claude.js', () => ({
  ClaudeEngine: class {
    id = 'claude'
    constructor() { built.engines.push(this) }
    async *run() { yield { type: 'result', text: 'not used' } }
    async runTools(job: ToolSessionJob) {
      const seen = await job.tools[0]!.run({ shelf: 'top' })
      return { answer: `found ${String(seen)}` }
    }
  },
  trimWarm: () => {},
  closeVoices: () => {},
}))

const { cloudEngine } = await import('../src/main/engine-cloud.js')
const folder = resolve(__dirname, '../../../tmp/trace-wiring-fixture')
afterEach(() => { delete process.env['ENGRAM_TRACE']; rmSync(folder, { recursive: true, force: true }) })

const job = (): ToolSessionJob => ({
  workdir: '/fixture' as EngineCwd,
  system: 'You sort a pantry.',
  prompt: 'Where is the flour?',
  maxCalls: 2,
  tools: [{ name: 'shelf', description: 'Reads a shelf', argsSchema: { type: 'object' }, run: async () => 'flour, oats' }],
})

it('leaves one readable trace line for a job when the trace folder is set', async () => {
  process.env['ENGRAM_TRACE'] = folder
  const result = await cloudEngine('claude', 'pantry-traced').runTools!(job())
  expect(result.answer).toBe('found flour, oats')
  await expect.poll(() => existsSync(folder) ? readdirSync(folder).length : 0).toBe(1)
  const lines = readFileSync(join(folder, readdirSync(folder)[0]!), 'utf8').split('\n').filter(Boolean)
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'job', prompt: 'Where is the flour?', calls: [{ name: 'shelf', args: { shelf: 'top' }, threw: false }] })
})

it('writes nothing and hands back the engine it built when the trace folder is unset', async () => {
  const engine = cloudEngine('claude', 'pantry-plain')
  expect(engine).toBe(built.engines.at(-1))
  expect((await engine.runTools!(job())).answer).toBe('found flour, oats')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(existsSync(folder)).toBe(false)
})
