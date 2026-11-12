import { CHARACTERS, defaultCharacter, type CharacterId } from './botAvatar.js'

export const PICKER_COLUMNS = 4

// Arrows move ±1 across and ±4 down, wrapping, in the 4x4 grid.
export function stepGrid(index: number, count: number, key: string): number | null {
  if (key === 'ArrowRight') return (index + 1) % count
  if (key === 'ArrowLeft') return (index - 1 + count) % count
  if (key === 'ArrowDown') return (index + PICKER_COLUMNS) % count
  if (key === 'ArrowUp') return (index - PICKER_COLUMNS + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function pickerOptions(): readonly CharacterId[] {
  return CHARACTERS
}

export type AvatarChange = { kind: 'pick'; next: CharacterId } | { kind: 'default' }
export type AvatarOps = { update(avatar: { character: CharacterId }): Promise<{ avatar?: unknown }> }

// A later manual Default uses the plain hash of the real id; the no-repeat step only applies at creation.
export function changedAvatar(id: string, change: AvatarChange): { character: CharacterId } {
  return { character: change.kind === 'pick' ? change.next : defaultCharacter(id) }
}

// Writes for one bot run one at a time in call order; after stop() no completion is reported.
export function avatarSaver(id: string, ops: AvatarOps, done: (error?: unknown) => void) {
  let latest: unknown
  let pending = 0
  let stopped = false
  let tail: Promise<void> = Promise.resolve()
  const run = async (change: AvatarChange) => { latest = (await ops.update(changedAvatar(id, change))).avatar }
  const finish = (error?: unknown) => { pending--; if (!stopped) done(error) }
  return {
    id,
    save(change: AvatarChange, current: unknown) {
      if (pending++ === 0) latest = current
      tail = tail.then(() => run(change)).then(() => finish(), (error: unknown) => finish(error))
    },
    stop() { stopped = true },
    idle: () => pending === 0,
    latest: () => latest,
  }
}
