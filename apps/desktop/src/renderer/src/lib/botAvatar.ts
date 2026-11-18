import { resolveCharacter, type OrbId } from '../../../../../../packages/core/src/bot-character.js'

export { CHARACTERS, ORBS, FALLBACK_CHARACTER, defaultCharacter, fnv1a, type CharacterId, type OrbId } from '../../../../../../packages/core/src/bot-character.js'

export const SMALL_MAX_PX = 32
export const RIPPLE_MIN_PX = 64

export function avatarCharacter(id: string, override?: unknown): OrbId {
  return resolveCharacter(id, override)
}
