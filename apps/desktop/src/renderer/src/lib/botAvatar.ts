import { FALLBACK_CHARACTER, resolveCharacter, type CharacterId } from '../../../../../../packages/core/src/bot-character.js'
import { CHARACTER_ART } from './botAvatarParts.js'

export { CHARACTERS, FALLBACK_CHARACTER, defaultCharacter, fnv1a, isCharacterId, resolveCharacter, type CharacterId } from '../../../../../../packages/core/src/bot-character.js'

// At or below this many CSS pixels the @opt master is shown; it is tuned to stay sharp when small.
export const OPT_MAX_PX = 24

export function avatarCharacter(id: string, override?: unknown): CharacterId {
  return resolveCharacter(id, override)
}

export function characterSrc(character: CharacterId, displayPx: number): string {
  const art = CHARACTER_ART[character] ?? CHARACTER_ART[FALLBACK_CHARACTER]
  return displayPx <= OPT_MAX_PX ? art.opt : art.full
}
