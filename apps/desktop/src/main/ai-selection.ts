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

// A brain at its usage limit, until when. Meanwhile a conversation that did
// not name its brain goes to the other signed-in one, and says so.
const limitedUntil = new Map<string, number>()
const LIMIT_WAIT_MS = 30 * 60_000
export function noteLimited(id: string, scope: string, retryAfterMs?: number, now = Date.now()): void {
  limitedUntil.set(`${scope}:${id}`, now + (retryAfterMs && retryAfterMs > 0 ? retryAfterMs : LIMIT_WAIT_MS))
}
export const isLimited = (id: string, scope: string, now = Date.now()): boolean => (limitedUntil.get(`${scope}:${id}`) ?? 0) > now
export const brainName = (id: string): string => id === 'claude' ? 'Claude' : id === 'codex' ? 'ChatGPT' : id

export async function chatEngine(scope: string, engines: Engine[], explicit?: string): Promise<Engine | undefined> {
  if (process.env['ENGRAM_ENGINE'] === 'none') return undefined
  if (process.env['ENGRAM_ENGINE'] === 'mock') return engines.find(engine => engine.id === 'mock')
  const settings = await loadSettings()
  const selection = aiSelection(settings, scope)
  const id = explicit || selection.engine
  if (id !== 'claude' && id !== 'codex') throw new Error('Invalid AI provider')
  const signedIn = async (wanted: 'claude' | 'codex') => {
    const engine = createEngine(wanted)
    if (!(await engine.detect()).loggedIn) return undefined
    return wanted === selection.engine
      ? withModel(engine, selection.model, selection.effort)
      : withModel(engine, (wanted === 'claude' ? settings.claudeModel : settings.codexModel) ?? '', wanted === 'claude' ? settings.claudeEffort : settings.codexEffort)
  }
  const other = id === 'claude' ? 'codex' : 'claude'
  if (!explicit && isLimited(id, scope)) {
    if (isLimited(other, scope)) throw new Error('Both AI providers reached their usage limits. Wait for a reset or select an available account.')
    const alternate = await signedIn(other)
    if (!alternate) throw new Error(`${brainName(id)} reached its usage limit and ${brainName(other)} is not connected.`)
    return alternate
  }
  return signedIn(id)
}
