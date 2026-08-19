import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'

// The errand's memory of itself. A delegation the user cannot audit afterwards
// reads as a black box, so every run — finished, failed or stopped — leaves
// one line here: what was asked, what came back, what it read along the way.

export interface ErrandRecord {
  id: string
  goal: string
  startedAt: string
  endedAt: string
  outcome: 'done' | 'failed' | 'aborted'
  title?: string
  // The proposal card the run produced, so history can open it in review.
  cardId?: string
  noteSources: number
  pages: { url: string; title: string }[]
  error?: string
}

const JOURNAL_FILE = 'errands.jsonl'
// Enough to scroll a season of delegations; older lines fall off the end.
const JOURNAL_CAP = 100

function journalPath(paths: VaultPaths): string {
  return join(paths.cache, JOURNAL_FILE)
}

export async function appendErrandRecord(paths: VaultPaths, record: ErrandRecord): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  const rows = await readErrandJournal(paths, JOURNAL_CAP - 1)
  const next = [record, ...rows]
  // Rewritten newest-first in full: the file stays small, and one write keeps
  // the cap exact without a separate truncation pass.
  await writeFile(journalPath(paths), `${next.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

export async function readErrandJournal(paths: VaultPaths, limit = JOURNAL_CAP): Promise<ErrandRecord[]> {
  try {
    const raw = await readFile(journalPath(paths), 'utf8')
    const rows: ErrandRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as ErrandRecord
        if (typeof parsed?.id === 'string' && typeof parsed?.goal === 'string') rows.push(parsed)
      } catch {
        // one corrupt line must not cost the whole history
      }
    }
    return rows.slice(0, limit)
  } catch {
    return []
  }
}
