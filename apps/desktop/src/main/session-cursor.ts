import { readFile, writeFile } from 'node:fs/promises'
import { renameWithRetry, type SessionTurn } from 'core'

export interface SessionCursor {
  offset: number
  held: SessionTurn[]
  lastGrewAt: number
  kept: string[]
}

export async function readSessionCursors(file: string): Promise<Map<string, SessionCursor> | null> {
  let text: string
  try { text = await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const raw: unknown = JSON.parse(text)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session cursor state')
  return new Map(Object.entries(raw).map(([name, value]) => {
    const cursor = value as Partial<SessionCursor> | null
    if (!cursor || !Number.isSafeInteger(cursor.offset) || cursor.offset! < 0 ||
      (cursor.held !== undefined && (!Array.isArray(cursor.held) || cursor.held.some(turn =>
        !turn || !['user', 'assistant'].includes(turn.role) || typeof turn.text !== 'string' || typeof turn.at !== 'string'))) ||
      (cursor.kept !== undefined && (!Array.isArray(cursor.kept) || cursor.kept.some(title => typeof title !== 'string'))))
      throw new Error('Invalid session cursor state')
    return [name, { offset: cursor.offset!, held: cursor.held ?? [],
      lastGrewAt: typeof cursor.lastGrewAt === 'number' ? cursor.lastGrewAt : 0, kept: cursor.kept ?? [] }]
  }))
}

export async function writeSessionCursors(file: string, cursors: Map<string, SessionCursor>): Promise<void> {
  // One scan owns this snapshot. A failed replacement leaves the previous checkpoint intact.
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(Object.fromEntries(cursors)))
  await renameWithRetry(temporary, file)
}
