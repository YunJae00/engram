import { holdModelTaskEngine } from './model-call-gate.js'
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
  holdModelTaskEngine(engine.id)
  const selected: Engine = Object.create(engine) as Engine
  selected.detect = () => engine.detect()
  selected.run = job => engine.run({ ...job, model, effort })
  if (engine.runTools) selected.runTools = job => engine.runTools!({ ...job, model, effort: job.effort ?? effort })
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

const limitedUntil = new Map<string, { until: number; known: boolean }>()
const LIMIT_WAIT_MS = 30 * 60_000
export function noteLimited(id: string, scope: string, retryAfterMs?: number, now = Date.now()): void {
  const known = !!retryAfterMs && retryAfterMs > 0
  limitedUntil.set(`${scope}:${id}`, { until: now + (known ? retryAfterMs : LIMIT_WAIT_MS), known })
}
export const limitedAt = (id: string, scope: string): number | undefined => {
  const held = limitedUntil.get(`${scope}:${id}`)
  return held?.known ? held.until : undefined
}
export const isLimited = (id: string, scope: string, now = Date.now()): boolean => (limitedUntil.get(`${scope}:${id}`)?.until ?? 0) > now
export const brainName = (id: string): string => id === 'claude' ? 'Claude' : id === 'codex' ? 'ChatGPT' : id

export async function chatEngine(scope: string, engines: Engine[]): Promise<Engine | undefined> {
  if (process.env['ENGRAM_ENGINE'] === 'none') return undefined
  if (process.env['ENGRAM_ENGINE'] === 'mock') return engines.find(engine => engine.id === 'mock')
  const engine = createEngine('claude')
  holdModelTaskEngine('claude')
  const status = await engine.detect()
  if (!status.loggedIn && status.conclusive !== false) return undefined
  return engine
}
