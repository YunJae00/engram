import type { StringKey } from '../i18n.js'
import { AVATAR_RANGES, avatarSpec } from './botAvatar.js'
import { previewCharacter, type Character } from './createBot.js'

export type Part = 'body' | 'face' | 'accessory' | 'palette'

export function currentCharacter(id: string, avatar: unknown): Character {
  const spec = avatarSpec(id, avatar, false)
  if (spec.kind === 'drawn' && typeof spec.body === 'number' && typeof spec.palette === 'number') {
    return { body: spec.body, face: spec.face, accessory: spec.accessory, palette: spec.palette }
  }
  return previewCharacter(id, 0)
}

function upTo(max: number): number[] {
  const values: number[] = []
  for (let i = 0; i <= max; i++) values.push(i)
  return values
}

export function pickerOptions(primary: boolean): { body: readonly (number | 'sun')[]; face: readonly number[]; accessory: readonly number[]; palette: readonly number[] } {
  return {
    body: primary ? ['sun'] : upTo(AVATAR_RANGES.body),
    face: upTo(AVATAR_RANGES.face),
    accessory: upTo(AVATAR_RANGES.accessory),
    palette: upTo(AVATAR_RANGES.palette),
  }
}

export function withPart(character: Character, part: Part, value: number): Character {
  return { ...character, [part]: value }
}

export function randomCharacter(id: string, n: number, accessory: number): Character {
  return previewCharacter(`${id}${n}`, accessory)
}

export function stepRadio(index: number, count: number, key: string): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function optionLabel(part: Part, value: number | 'sun'): StringKey {
  return value === 'sun' ? 'avatarPicker.bodySun' : `avatarPicker.${part}${value}` as StringKey
}

export type AvatarChange = { kind: 'pick'; next: Character } | { kind: 'default' } | { kind: 'photo'; data: Uint8Array }
export type AvatarOps = {
  update(avatar: Character | undefined): Promise<{ avatar?: unknown }>
  set(data: Uint8Array): Promise<{ avatar?: unknown }>
  clear(): Promise<{ avatar?: unknown }>
}

// Writes run one at a time in call order; Default reads the last stored value, never a stale prop.
export function avatarSaver(id: string, ops: AvatarOps, done: (error?: unknown) => void) {
  let latest: unknown
  let pending = 0
  let tail: Promise<void> = Promise.resolve()
  const run = async (change: AvatarChange) => {
    const saved = change.kind === 'pick' ? await ops.update(change.next)
      : change.kind === 'photo' ? await ops.set(change.data)
        : avatarSpec(id, latest).kind === 'image' ? await ops.clear() : await ops.update(undefined)
    latest = saved.avatar
  }
  return {
    save(change: AvatarChange, current: unknown) {
      if (pending++ === 0) latest = current
      tail = tail.then(() => run(change)).then(() => { pending--; done() }, (error: unknown) => { pending--; done(error) })
    },
    idle: () => pending === 0,
    latest: () => latest,
  }
}
