import { basename } from 'node:path'
import { createCard, type Card } from './cards.js'
import { collectResult, engineCwd, type Engine } from './engine/types.js'
import { generateNoteId } from './id.js'
import { readNote, writeNote } from './notes.js'
import { parseNote } from './schema.js'
import type { TeamSync } from './sync.js'

export interface ConflictResolution {
  cards: Card[]
  preservedBoth: string[]
}

async function stageContent(sync: TeamSync, stage: 1 | 2 | 3, file: string): Promise<string | null> {
  try {
    return await sync.raw().raw(['show', `:${stage}:${file}`])
  } catch {
    return null // e.g. added on both sides — no base
  }
}

function mergePrompt(base: string | null, ours: string, theirs: string): string {
  return [
    'Two team members edited the same note. Produce ONE merged note body that keeps every fact both sides added and resolves contradictions in favour of the newer information. Reply with the merged markdown body only.',
    '--- base ---',
    base ?? '(no common base)',
    '--- version A (mine) ---',
    ours,
    '--- version B (theirs) ---',
    theirs,
  ].join('\n\n')
}

export async function resolveConflicts(
  sync: TeamSync,
  conflicted: string[],
  engine: Engine | null,
): Promise<ConflictResolution> {
  const paths = sync.paths
  const result: ConflictResolution = { cards: [], preservedBoth: [] }

  for (const file of conflicted) {
    const base = await stageContent(sync, 1, file)
    const ours = await stageContent(sync, 2, file)
    const theirs = await stageContent(sync, 3, file)
    if (ours === null || theirs === null) {
      // add/delete conflict: keep whichever side still has content
      await sync.raw().raw(['checkout', ours !== null ? '--ours' : '--theirs', '--', file])
      await sync.raw().add([file])
      continue
    }

    const noteId = basename(file, '.md')
    let proposal: string | null = null
    if (engine) {
      try {
        const merged = await collectResult(engine, { prompt: mergePrompt(base, ours, theirs), workdir: engineCwd(paths) })
        proposal = merged.trim()
      } catch {
        proposal = null
      }
    }

    // Unstick the merge with OUR side; the approved card lands the real merge.
    await sync.raw().raw(['checkout', '--ours', '--', file])
    await sync.raw().add([file])

    if (proposal) {
      result.cards.push(
        await createCard(paths, {
          cardType: 'merge',
          targets: [noteId],
          rationale: 'Both sides edited this note — proposed merge keeps additions from A and B',
          proposed: proposal.startsWith('---') ? parseNote(proposal).body : proposal,
          job: 'sync',
        }),
      )
    } else {
      const theirNote = parseNote(theirs)
      theirNote.front.id = generateNoteId()
      theirNote.front.status = 'disputed'
      await writeNote(paths, theirNote)
      const ourNote = await readNote(paths, noteId)
      ourNote.front.status = 'disputed'
      ourNote.front.updated = new Date().toISOString()
      await writeNote(paths, ourNote)
      await sync.raw().add(['-A'])
      result.preservedBoth.push(noteId)
    }
  }

  await sync.raw().commit('sync: resolve conflicts (librarian pipeline)')
  return result
}
