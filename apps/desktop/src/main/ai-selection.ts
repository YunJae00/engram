import { createEngine, type Engine, type ReasoningEffort } from 'core'
import { loadSettings, updateSettings } from './settings.js'
import type { AppSettingsDto } from '../shared/types.js'

export function aiSelection(settings: AppSettingsDto, scope: string) {
  return settings.aiSelections?.[scope] ?? {
    engine: settings.defaultEngine,
    model: (settings.defaultEngine === 'claude' ? settings.claudeModel : settings.codexModel) ?? '',
    effort: settings.defaultEngine === 'claude' ? settings.claudeEffort : settings.codexEffort,
  }
}

export function withModel(engine: Engine, model: string, effort?: ReasoningEffort): Engine {
  const selected: Engine = Object.create(engine) as Engine
  selected.detect = () => engine.detect()
  selected.run = job => engine.run({ ...job, model, effort })
  if (engine.runTools) selected.runTools = job => engine.runTools!({ ...job, model, effort })
  return selected
}

export async function rememberSelections(scopes: string[]): Promise<void> {
  const settings = await loadSettings()
  if (scopes.every(scope => settings.aiSelections[scope])) return
  await updateSettings(held => ({ ...held, aiSelections: {
    ...held.aiSelections,
    ...Object.fromEntries(scopes.map(scope => [scope, aiSelection(held, scope)])),
  } }))
}

export async function chatEngine(scope: string, engines: Engine[], explicit?: string): Promise<Engine | undefined> {
  if (process.env['ENGRAM_ENGINE'] === 'none') return undefined
  if (process.env['ENGRAM_ENGINE'] === 'mock') return engines.find(engine => engine.id === 'mock')
  const selection = aiSelection(await loadSettings(), scope)
  const id = explicit || selection.engine
  if (id !== 'claude' && id !== 'codex') throw new Error('Invalid AI provider')
  const engine = createEngine(id)
  if (!(await engine.detect()).loggedIn) return undefined
  return withModel(engine, selection.model, selection.effort)
}
