import type { ReasoningEffort } from './types.js'

export type EngineTierMap = Record<'fast' | 'work' | 'smart', { model?: string; effort: ReasoningEffort }>

export function pickEngineTier(map: EngineTierMap, hint?: 'fast' | 'smart', settingsModel = '', override: { model?: string; effort?: ReasoningEffort } = {}): { model?: string; effort: ReasoningEffort } {
  const tier = map[hint ?? 'work']
  const model = (override.model ?? (hint ? tier.model : settingsModel.trim() || tier.model))?.trim()
  return { ...(model ? { model } : {}), effort: override.effort ?? tier.effort }
}
