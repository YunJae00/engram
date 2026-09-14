import { expect, it, vi } from 'vitest'
import type { Engine, EngineJobInput, ToolSessionJob } from 'core'
import { aiSelection, withModel } from '../src/main/ai-selection.js'
import type { AppSettingsDto } from '../src/shared/types.js'

vi.mock('../src/main/settings.js', () => ({ loadSettings: vi.fn(), updateSettings: vi.fn() }))

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
