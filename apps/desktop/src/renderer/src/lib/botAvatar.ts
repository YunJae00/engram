import { resolveCharacter, type OrbId } from '../../../../../../packages/core/src/bot-character.js'

export { CHARACTERS, ORBS, FALLBACK_CHARACTER, defaultCharacter, fnv1a, isCharacterId, isOrbId, orbOf, resolveCharacter, type CharacterId, type OrbId } from '../../../../../../packages/core/src/bot-character.js'

// Below this many CSS pixels an orb is drawn static.
export const OPT_MAX_PX = 24

export function avatarCharacter(id: string, override?: unknown): OrbId {
  return resolveCharacter(id, override)
}
