import { resolveCharacter, type OrbId } from '../../../../../../packages/core/src/bot-character.js'

export { CHARACTERS, ORBS, FALLBACK_CHARACTER, defaultCharacter, fnv1a, type CharacterId, type OrbId } from '../../../../../../packages/core/src/bot-character.js'

// Up to this many CSS pixels an orb is the small master and sits still unless its bot is working.
export const SMALL_MAX_PX = 32
// From this many CSS pixels the wave is redrawn so its ripple travels; under it the only motion is a css breathe.
export const RIPPLE_MIN_PX = 64

export function avatarCharacter(id: string, override?: unknown): OrbId {
  return resolveCharacter(id, override)
}
