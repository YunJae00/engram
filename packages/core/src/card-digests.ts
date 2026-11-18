import { createHash } from 'node:crypto'
import type { Card } from './cards.js'
import { readNote } from './notes.js'
import type { VaultPaths } from './vault.js'

function bodyDigest(body: string): string {
  return createHash('sha1').update(body).digest('hex').slice(0, 12)
}

export async function snapshotTargetDigests(paths: VaultPaths, card: Card): Promise<void> {
  if (card.targets.length === 0) return
  const digests: Record<string, string> = {}
  for (const id of card.targets) {
    try {
      digests[id] = bodyDigest((await readNote(paths, id)).body)
    } catch {
    }
  }
  if (Object.keys(digests).length > 0) card.target_digests = digests
}

export async function editedSinceResolution(paths: VaultPaths, card: Card): Promise<boolean> {
  if (card.targets.length === 0) return false
  if (card.target_digests) {
    for (const id of card.targets) {
      const then = card.target_digests[id]
      if (!then) continue
      try {
        if (bodyDigest((await readNote(paths, id)).body) !== then) return true
      } catch {
      }
    }
    return false
  }
  const resolvedAt = Date.parse(card.resolved ?? card.created)
  for (const id of card.targets) {
    try {
      if (Date.parse((await readNote(paths, id)).front.updated) > resolvedAt) return true
    } catch {
    }
  }
  return false
}

export async function spentByResolution(paths: VaultPaths, pending: Card, shared: string[]): Promise<boolean> {
  const raisedWith = pending.target_digests
  if (!raisedWith) return true
  for (const id of shared) {
    const then = raisedWith[id]
    if (then === undefined) return true
    try {
      const note = await readNote(paths, id)
      if (note.front.status === 'superseded') return true
      if (bodyDigest(note.body) !== then) return true
    } catch {
      return true
    }
  }
  return false
}
