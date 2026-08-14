import { createHash } from 'node:crypto'
import type { Card } from './cards.js'
import { readNote } from './notes.js'
import type { VaultPaths } from './vault.js'

// A card's memory of its targets. Answering, dismissing or even neighbouring a
// card rewrites its targets' FRONTMATTER (status flips, dispute release,
// supersedes rewiring, verification stamps) and bumps `updated` — so every
// question about "did this note move?" has to compare BODIES, never timestamps.
// Card lifecycle decisions built on this live in cards.ts.

function bodyDigest(body: string): string {
  return createHash('sha1').update(body).digest('hex').slice(0, 12)
}

// Fingerprint the targets' bodies as they stand right now — called when a card
// is raised (so a pending question remembers what it was judged against) and
// again when it resolves, so "answered state" survives the librarian's own
// frontmatter surgery on those notes.
export async function snapshotTargetDigests(paths: VaultPaths, card: Card): Promise<void> {
  if (card.targets.length === 0) return
  const digests: Record<string, string> = {}
  for (const id of card.targets) {
    try {
      digests[id] = bodyDigest((await readNote(paths, id)).body)
    } catch {
      /* target gone — absence is judged at compare time */
    }
  }
  if (Object.keys(digests).length > 0) card.target_digests = digests
}

// Did any target note MEANINGFULLY change after this card left 'proposed'?
// Digest-carrying cards compare body content (librarian frontmatter edits are
// invisible); legacy cards fall back to the `updated`-stamp comparison.
export async function editedSinceResolution(paths: VaultPaths, card: Card): Promise<boolean> {
  if (card.targets.length === 0) return false
  if (card.target_digests) {
    for (const id of card.targets) {
      const then = card.target_digests[id]
      if (!then) continue // was already gone at resolution
      try {
        if (bodyDigest((await readNote(paths, id)).body) !== then) return true
      } catch {
        /* target gone — not a re-open */
      }
    }
    return false
  }
  const resolvedAt = Date.parse(card.resolved ?? card.created)
  for (const id of card.targets) {
    try {
      if (Date.parse((await readNote(paths, id)).front.updated) > resolvedAt) return true
    } catch {
      /* target gone — not a re-open */
    }
  }
  return false
}

// Did a resolution consume the ground a still-pending card stands on? A shared
// target is spent when the answer retired it (supersede/merge/retire) or
// rewrote its BODY; a frontmatter-only touch leaves the pending question
// exactly as valid as when it was raised. Cards written before creation-time
// digests existed carry no baseline — they keep the old blanket behaviour
// rather than guess.
export async function spentByResolution(paths: VaultPaths, pending: Card, shared: string[]): Promise<boolean> {
  const raisedWith = pending.target_digests
  if (!raisedWith) return true
  for (const id of shared) {
    const then = raisedWith[id]
    if (then === undefined) return true // no baseline for this target
    try {
      const note = await readNote(paths, id)
      if (note.front.status === 'superseded') return true // retired by the answer
      if (bodyDigest(note.body) !== then) return true
    } catch {
      return true // target gone — the question has no subject left
    }
  }
  return false
}
