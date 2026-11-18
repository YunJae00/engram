export const ORBS = ['orb-violet', 'orb-blue', 'orb-teal', 'orb-green', 'orb-amber', 'orb-rose', 'orb-lilac', 'orb-silver'] as const

export type OrbId = (typeof ORBS)[number]

// Legacy faces: no longer drawn, kept so stored picks stay valid.
export const CHARACTERS = [
  '01-bean-tilt', '02-cloud', '03-cashew', '04-lobe', '05-squircle', '06-triangle', '07-oval', '08-knob',
  '09-pill', '10-comma', '11-peanut', '12-crescent', '13-donut', '14-drop', '15-hourglass', '16-diamond',
] as const

export type CharacterId = OrbId | (typeof CHARACTERS)[number]

export const FALLBACK_CHARACTER: OrbId = 'orb-violet'

export function isOrbId(value: unknown): value is OrbId {
  return typeof value === 'string' && (ORBS as readonly string[]).includes(value)
}

export function isCharacterId(value: unknown): value is CharacterId {
  return isOrbId(value) || (typeof value === 'string' && (CHARACTERS as readonly string[]).includes(value))
}

export function orbOf(character: CharacterId): OrbId {
  return isOrbId(character) ? character : ORBS[(CHARACTERS as readonly string[]).indexOf(character) % ORBS.length]!
}

export function fnv1a(id: string): number {
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(id)) {
    h ^= byte
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

const validId = (id: unknown): id is string => typeof id === 'string' && id.trim() !== ''

// The previous orb is skipped once so two chats made in a row never share an orb.
export function defaultCharacter(id: unknown, previousIndex?: number): OrbId {
  if (!validId(id)) return FALLBACK_CHARACTER
  let index = fnv1a(id) % ORBS.length
  if (index === previousIndex) index = (index + 1) % ORBS.length
  return ORBS[index]!
}

export function characterIndex(character: CharacterId): number {
  return ORBS.indexOf(orbOf(character))
}

// Each property is read once, so a hostile getter cannot change a value after it was checked.
function storedCharacter(avatar: unknown): CharacterId | null | undefined {
  try {
    if (typeof avatar !== 'object' || avatar === null || Array.isArray(avatar)) return undefined
    if (!Object.hasOwn(avatar, 'character')) return undefined
    const keys = Reflect.ownKeys(avatar)
    const value = (avatar as Record<string, unknown>).character
    return keys.length === 1 && isCharacterId(value) ? value : null
  } catch {
    return null
  }
}

// A stored pick wins (a legacy face shows as its orb); legacy drawings, photos and empty avatars hash the real id; malformed picks fall back.
export function resolveCharacter(id: unknown, avatar: unknown): OrbId {
  const stored = storedCharacter(avatar)
  if (stored) return orbOf(stored)
  if (stored === null) return FALLBACK_CHARACTER
  return defaultCharacter(id)
}

// Time plus 16 random bits; a taken suffix moves to the next free one, and a full millisecond refuses.
export function newBotId(taken: ReadonlySet<string>, now: Date, random = Math.random()): string {
  const start = Math.floor(random * 0xffff)
  for (let step = 0; step <= 0xffff; step++) {
    const id = `bot-${now.getTime().toString(36)}-${((start + step) % 0x10000).toString(16)}`
    if (!taken.has(id)) return id
  }
  throw new Error('no free comet id is left for this moment; try again')
}

export function assignCharacter(id: string, previous: { id: string; avatar?: unknown } | undefined, explicit?: CharacterId): OrbId {
  if (explicit !== undefined) return orbOf(explicit)
  return defaultCharacter(id, previous ? characterIndex(resolveCharacter(previous.id, previous.avatar)) : undefined)
}
