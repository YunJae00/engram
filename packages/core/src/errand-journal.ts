import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'

export interface ErrandRecord {
  id: string
  goal: string
  startedAt: string
  endedAt: string
  outcome: 'done' | 'failed' | 'aborted'
  title?: string
  cardId?: string
  noteSources: number
  pages: { url: string; title: string }[]
  error?: string
}

const JOURNAL_FILE = 'errands.jsonl'
const JOURNAL_CAP = 100

function journalPath(paths: VaultPaths): string {
  return join(paths.cache, JOURNAL_FILE)
}

export async function appendErrandRecord(paths: VaultPaths, record: ErrandRecord): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  const rows = await readErrandJournal(paths, JOURNAL_CAP - 1)
  const next = [record, ...rows]
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
      }
    }
    return rows.slice(0, limit)
  } catch {
    return []
  }
}
