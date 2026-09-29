import { expect, it, vi } from 'vitest'
import type { Engine, EngineJobInput, ToolSessionJob } from 'core'
import { aiSelection, chatEngine, isLimited, noteLimited, withModel } from '../src/main/ai-selection.js'
import { loadSettings } from '../src/main/settings.js'
import type { AppSettingsDto } from '../src/shared/types.js'

vi.mock('../src/main/settings.js', () => ({ loadSettings: vi.fn(), updateSettings: vi.fn() }))
const models = vi.hoisted(() => [] as string[])
const status = vi.hoisted(() => ({ current: { installed: true, loggedIn: true } as { installed: boolean; loggedIn: boolean; conclusive?: boolean } }))
vi.mock('core', async (original) => ({
  ...await original<typeof import('core')>(),
  createEngine: (id: string) => ({
    id, detect: async () => status.current,
    async *run(job: EngineJobInput) { models.push(`${id}:${job.model}`); yield { type: 'result', text: 'ok' } },
  }),
}))

it('hands a conversation to the other signed-in brain while its own is at the usage limit', async () => {
  vi.mocked(loadSettings).mockResolvedValue({ defaultEngine: 'claude', claudeModel: 'opus', codexModel: 'gpt', autoStart: false, teamSync: 'manual', aiSelections: {} })
  const pick = async (explicit?: string) => {
    const engine = (await chatEngine('bot-1', [], explicit))!
    for await (const event of engine.run({} as EngineJobInput)) expect(event.type).toBe('result')
    return engine.id
  }
  expect(await pick()).toBe('claude')
  noteLimited('claude', 'bot-1', 60_000)
  expect(await pick()).toBe('codex')
  expect(await pick('claude')).toBe('claude')
  expect((await chatEngine('bot-2', []))!.id).toBe('claude')
  noteLimited('codex', 'bot-1')
  await expect(pick()).rejects.toThrow('Both AI providers')
  expect(models).toEqual(['claude:opus', 'codex:gpt', 'claude:opus'])
  expect(isLimited('claude', 'bot-1', Date.now() + 61_000)).toBe(false)
})

it('goes ahead when the sign-in check could not tell, and stops only on a real sign-out', async () => {
  vi.mocked(loadSettings).mockResolvedValue({ defaultEngine: 'claude', claudeModel: 'opus', autoStart: false, teamSync: 'manual', aiSelections: {} })
  status.current = { installed: true, loggedIn: false, conclusive: false }
  expect((await chatEngine('bot-3', []))?.id).toBe('claude')
  status.current = { installed: true, loggedIn: false, conclusive: true }
  expect(await chatEngine('bot-3', [])).toBeUndefined()
  status.current = { installed: true, loggedIn: true }
})

it('keeps filing and conversation choices independent of new-conversation defaults', () => {
  const settings: AppSettingsDto = { defaultEngine: 'claude', claudeModel: 'default', autoStart: false, teamSync: 'manual', aiSelections: {
    filing: { engine: 'codex', model: 'small' },
    'bot-one': { engine: 'claude', model: 'large' },
  } }
  expect(aiSelection(settings, 'filing')).toEqual({ engine: 'codex', model: 'small' })
  expect(aiSelection(settings, 'bot-one')).toEqual({ engine: 'claude', model: 'large' })
  expect(aiSelection(settings, 'bot-two')).toEqual({ engine: 'claude', model: 'default' })
  settings.defaultEngine = 'codex'
  expect(aiSelection(settings, 'bot-one').model).toBe('large')
  expect(aiSelection(settings, 'filing').model).toBe('small')
})

it('passes each model to text and tool sessions without mutating the shared engine', async () => {
  const calls: string[] = []
  const engine: Engine = {
    id: 'claude', desktopToolIsolation: true,
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run(job) { expect(this).toBe(engine); expect(job.effort).toBe('high'); calls.push(job.model!); yield { type: 'result', text: 'ok' } },
    async runTools(job) { expect(this).toBe(engine); expect(job.effort).toBe('low'); calls.push(job.model!); return { answer: 'ok' } },
  }
  const original = engine.run
  const first = withModel(engine, 'large', 'high'), second = withModel(engine, '', 'low')
  await Promise.all([
    (async () => { for await (const result of first.run({} as EngineJobInput)) expect(result.type).toBe('result') })(),
    second.runTools!({} as ToolSessionJob),
  ])
  expect(calls.sort()).toEqual(['', 'large'])
  expect(engine.run).toBe(original)
  expect(first.desktopToolIsolation).toBe(true)
})
