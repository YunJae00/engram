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

// Claude at its usage limit, until when. There is no other engine to hand
// the turn to: the person is told plainly when it can pick up again.
// Without a reset time from Claude the wait is a guess, so it is never shown as one.
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

// In-app work runs on Claude only: a stored 'codex' choice or a request that
// names another engine still gets Claude, and a usage limit never switches.
export async function chatEngine(scope: string, engines: Engine[]): Promise<Engine | undefined> {
  if (process.env['ENGRAM_ENGINE'] === 'none') return undefined
  if (process.env['ENGRAM_ENGINE'] === 'mock') return engines.find(engine => engine.id === 'mock')
  const engine = createEngine('claude')
  holdModelTaskEngine('claude')
  // A status check that timed out on a busy runtime is not a sign-out: the
  // call goes ahead, and a real sign-out fails it with an auth error.
  const status = await engine.detect()
  if (!status.loggedIn && status.conclusive !== false) return undefined
  return engine
}
