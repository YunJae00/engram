import type { BotAvatar, BotPatch } from './bots.js'

// Inclusive maxima; every part starts at 0.
export const AVATAR_RANGES = { body: 5, face: 5, accessory: 8, palette: 7 } as const

export const BOT_LABEL_CHARS = 40
const NOTIFY = ['all', 'attention', 'off']
const PATCH_KEYS = new Set(['name', 'purpose', 'avatar', 'label', 'primary', 'hidden', 'notify', 'skills', 'templateId'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function isBotAvatar(value: unknown): value is BotAvatar {
  if (!isRecord(value)) return false
  if (hasExactKeys(value, ['image'])) return typeof value.image === 'string'
  const parts = Object.keys(AVATAR_RANGES) as (keyof typeof AVATAR_RANGES)[]
  return hasExactKeys(value, parts) && parts.every(part => {
    const n = value[part]
    return Number.isInteger(n) && (n as number) >= 0 && (n as number) <= AVATAR_RANGES[part]
  })
}

export function isStringList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  // Index loop, not every(): every() skips holes in a sparse array.
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || typeof value[i] !== 'string') return false
  return true
}

// Pure check of an already-copied patch; undefined means valid. An own undefined clears an optional field.
export function botPatchError(copy: BotPatch): string | undefined {
  if (!isRecord(copy)) return 'a bot change must be an object'
  for (const key of Object.keys(copy)) if (!PATCH_KEYS.has(key)) return `${key} cannot be changed`
  if (Object.hasOwn(copy, '__proto__')) return '__proto__ cannot be changed'
  const has = (key: keyof BotPatch) => Object.hasOwn(copy, key)
  const optional = (key: keyof BotPatch, ok: (value: unknown) => boolean) => !has(key) || copy[key] === undefined || ok(copy[key])
  if (has('name') && (typeof copy.name !== 'string' || !copy.name.trim())) return 'a bot needs a name'
  if (has('purpose') && typeof copy.purpose !== 'string') return 'purpose must be text'
  if (!optional('avatar', isBotAvatar)) return 'avatar must be body 0-5, face 0-5, accessory 0-8, palette 0-7, or an image'
  if (!optional('label', v => typeof v === 'string' && Array.from(v).length <= BOT_LABEL_CHARS)) return `a label is at most ${BOT_LABEL_CHARS} characters`
  if (has('primary') && copy.primary !== undefined && typeof copy.primary !== 'boolean') return 'primary must be true or false'
  if (!optional('hidden', v => v === true)) return 'hidden must be true'
  if (!optional('notify', v => NOTIFY.includes(v as string))) return 'notify must be all, attention or off'
  if (!optional('skills', isStringList)) return 'skills must be a list of text'
  if (!optional('templateId', v => typeof v === 'string')) return 'templateId must be text'
  return undefined
}
